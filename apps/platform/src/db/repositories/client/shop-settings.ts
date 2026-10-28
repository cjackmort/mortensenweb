import { and, eq, isNull } from "drizzle-orm";
import type Stripe from "stripe";
import type { Database } from "@/db/client";
import { auditLog, SHOP_FULFILMENTS, shopSettings, sites } from "@/db/schema";
import { requireStripe, stripeConfigured } from "@/lib/payments/stripe";
import { accountStatusOf, connectReturnUrl, portalOrigin, type ConnectedAccountStatus } from "@/lib/shop/connect";
import { parseDollars } from "@/lib/shop/money";
import { assertMutable, type TenantContext } from "../context";

/**
 * A client's shop settings: the Stripe account that takes the money, and how
 * orders are fulfilled.
 *
 * One shop per site, and a client's shop is on their site. A tenant with
 * several sites gets the shop on the one furthest along (live before preview
 * before draft) — the shop is a page on a website, not a thing of its own.
 *
 * No row until the first write. A client who has only looked at the page has
 * no settings, and the defaults they saw are the ones the first save starts
 * from.
 *
 * ## Where the money goes
 *
 * `stripe_account_id` is where every sale is paid. It is written exactly once,
 * by the client pressing "Connect Stripe" in their own session, and never
 * from a form field, a webhook or an email. Nothing here changes it once it is
 * set: moving a shop to a different account is an operator job, out of band.
 */

export type ShopFulfilment = (typeof SHOP_FULFILMENTS)[number];

export interface ShopSettingsView {
  siteName: string;
  /** Where the shop will be, once it is on the site. */
  siteUrl: string | null;
  stripeAccountId: string | null;
  /** Mirrored from Stripe. The gate on checkout. */
  chargesEnabled: boolean;
  currency: string;
  fulfilment: ShopFulfilment;
  shippingCents: number;
  taxEnabled: boolean;
  refundPolicy: string | null;
  shippingPolicy: string | null;
  /** Null until the first save. */
  updatedAt: Date | null;
}

export type ShopResult = { ok: true; message: string } | { ok: false; message: string };

/** Policy text is rendered on the site; this keeps a pasted novel out of a product page. */
export const MAX_POLICY_CHARS = 2000;
/** $500 per order. Above this somebody typed cents into a dollars field. */
export const MAX_SHIPPING_CENTS = 50_000;

interface ShopSite {
  id: string;
  publicId: string;
  name: string;
  url: string | null;
}

const STATUS_RANK: Record<string, number> = { live: 0, preview: 1, draft: 2 };

/** The site a tenant's shop lives on, or null when they have no site yet. */
export async function shopSiteFor(db: Database, ctx: TenantContext): Promise<ShopSite | null> {
  const rows = await db
    .select({
      id: sites.id,
      publicId: sites.publicId,
      name: sites.name,
      status: sites.status,
      productionUrl: sites.productionUrl,
      primaryDomain: sites.primaryDomain,
      createdAt: sites.createdAt,
    })
    .from(sites)
    .where(and(eq(sites.organizationId, ctx.organizationId), isNull(sites.archivedAt)));
  if (rows.length === 0) return null;

  const [best] = [...rows].sort(
    (a, b) =>
      (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || a.createdAt.getTime() - b.createdAt.getTime(),
  );
  return {
    id: best!.id,
    publicId: best!.publicId,
    name: best!.name,
    url: best!.productionUrl ?? (best!.primaryDomain ? `https://${best!.primaryDomain}` : null),
  };
}

async function settingsRow(db: Database, ctx: TenantContext, siteId: string) {
  const [row] = await db
    .select()
    .from(shopSettings)
    .where(and(eq(shopSettings.organizationId, ctx.organizationId), eq(shopSettings.siteId, siteId)))
    .limit(1);
  return row ?? null;
}

function isFulfilment(value: string): value is ShopFulfilment {
  return (SHOP_FULFILMENTS as readonly string[]).includes(value);
}

/** The settings as the page shows them: the row, or the defaults the first save starts from. */
export async function getShopSettings(db: Database, ctx: TenantContext): Promise<ShopSettingsView | null> {
  const site = await shopSiteFor(db, ctx);
  if (!site) return null;
  const row = await settingsRow(db, ctx, site.id);

  return {
    siteName: site.name,
    siteUrl: site.url,
    stripeAccountId: row?.stripeAccountId ?? null,
    chargesEnabled: row?.chargesEnabled ?? false,
    currency: row?.currency ?? "usd",
    fulfilment: row && isFulfilment(row.fulfilment) ? row.fulfilment : "ship",
    shippingCents: row?.shippingCents ?? 0,
    taxEnabled: row?.taxEnabled ?? false,
    refundPolicy: row?.refundPolicy ?? null,
    shippingPolicy: row?.shippingPolicy ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

async function audit(
  db: Database,
  ctx: TenantContext,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await db.insert(auditLog).values({
    action,
    entityType: "shop_settings",
    entityId: null,
    actorUserId: ctx.userId,
    organizationId: ctx.organizationId,
    metadata,
  });
}

export interface ShopSettingsInput {
  fulfilment: string;
  /** Dollars as typed, "12.50". */
  shipping: string;
  taxEnabled: boolean;
  refundPolicy: string;
  shippingPolicy: string;
}

function cleanPolicy(text: string): string | null {
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Save how orders are fulfilled. Never touches the Stripe account. */
export async function saveShopSettings(
  db: Database,
  ctx: TenantContext,
  input: ShopSettingsInput,
): Promise<ShopResult> {
  assertMutable(ctx);
  const site = await shopSiteFor(db, ctx);
  if (!site) return { ok: false, message: "Your shop goes on your website, and there is no website on your account yet." };

  if (!isFulfilment(input.fulfilment)) return { ok: false, message: "Choose shipping or pickup." };

  // Pickup means nothing is posted, so no shipping rate: a rate left over
  // from before would be charged on an order that is collected.
  const shippingCents = input.fulfilment === "pickup" ? 0 : parseDollars(input.shipping);
  if (shippingCents === null) return { ok: false, message: "Enter the shipping rate in dollars, like 8.50." };
  if (shippingCents > MAX_SHIPPING_CENTS) {
    return { ok: false, message: "That shipping rate is over $500. Check it is in dollars, not cents." };
  }

  const refundPolicy = cleanPolicy(input.refundPolicy);
  const shippingPolicy = cleanPolicy(input.shippingPolicy);
  if ((refundPolicy?.length ?? 0) > MAX_POLICY_CHARS || (shippingPolicy?.length ?? 0) > MAX_POLICY_CHARS) {
    return { ok: false, message: `Keep each policy under ${MAX_POLICY_CHARS.toLocaleString()} characters.` };
  }

  const now = new Date();
  const values = {
    fulfilment: input.fulfilment,
    shippingCents,
    taxEnabled: input.taxEnabled,
    refundPolicy,
    shippingPolicy,
    updatedAt: now,
  };
  await db
    .insert(shopSettings)
    .values({ organizationId: ctx.organizationId, siteId: site.id, ...values })
    .onConflictDoUpdate({ target: shopSettings.siteId, set: values });
  await audit(db, ctx, "shop.settings_saved", {
    site: site.publicId,
    fulfilment: input.fulfilment,
    shippingCents,
    taxEnabled: input.taxEnabled,
  });

  return { ok: true, message: "Saved." };
}

export type ConnectStart = { ok: true; url: string } | { ok: false; message: string };

const CONNECT_UNAVAILABLE: ConnectStart = {
  ok: false,
  message: "Connecting Stripe is not switched on here yet. We will let you know when it is.",
};

/**
 * Begin, or resume, Stripe onboarding for this shop.
 *
 * The account object is created the first time and reused after that: a
 * client who closed the Stripe tab halfway and pressed the button again
 * continues the same onboarding rather than starting a second account they
 * would then have to pick between. The link itself is single-use and expires
 * in minutes, so a fresh one is made on every press.
 *
 * Creating the account is not the same as connecting it. Until Stripe
 * reports `charges_enabled`, the shop cannot sell, however many account ids
 * are stored.
 */
export async function startStripeConnect(db: Database, ctx: TenantContext): Promise<ConnectStart> {
  assertMutable(ctx);
  if (!stripeConfigured()) return CONNECT_UNAVAILABLE;
  const origin = portalOrigin();
  if (!origin) {
    console.error("[shop] AUTH_URL is unset; cannot build Stripe return URLs");
    return CONNECT_UNAVAILABLE;
  }
  const site = await shopSiteFor(db, ctx);
  if (!site) return { ok: false, message: "Your shop goes on your website, and there is no website on your account yet." };

  const stripe = requireStripe();
  const existing = await settingsRow(db, ctx, site.id);
  if (existing?.chargesEnabled) return { ok: false, message: "Stripe is already connected." };

  let accountId = existing?.stripeAccountId ?? null;
  try {
    if (!accountId) {
      const account = await stripe.accounts.create(
        {
          type: "standard",
          business_profile: site.url ? { url: site.url } : undefined,
          metadata: { site_public_id: site.publicId, organization_id: ctx.organizationId },
        },
        // One account per site, however many times the request is retried.
        { idempotencyKey: `shop-connect:${site.publicId}` },
      );
      accountId = account.id;
      await db
        .insert(shopSettings)
        .values({ organizationId: ctx.organizationId, siteId: site.id, stripeAccountId: accountId })
        .onConflictDoUpdate({
          target: shopSettings.siteId,
          set: { stripeAccountId: accountId, updatedAt: new Date() },
          // Only ever fills an empty slot. A row that already names an account
          // keeps it, whatever this call created.
          setWhere: isNull(shopSettings.stripeAccountId),
        });
      // Two presses at once can both create an account; the row decides which
      // one the shop uses, and the link is for that one.
      accountId = (await settingsRow(db, ctx, site.id))?.stripeAccountId ?? accountId;
      await audit(db, ctx, "shop.stripe_account_created", { site: site.publicId, account: accountId });
    }

    const link = await stripe.accountLinks.create({
      account: accountId,
      type: "account_onboarding",
      refresh_url: connectReturnUrl(origin, "refresh"),
      return_url: connectReturnUrl(origin, "return"),
    });
    return { ok: true, url: link.url };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    console.error("[shop] Stripe onboarding could not start", { site: site.publicId, message });
    // The platform account has not been signed up for Connect, or has not
    // finished its Connect platform profile (Stripe's questionnaire): operator
    // steps in the Stripe dashboard, not something the client can fix by
    // trying again.
    if (/signed up for Connect|platform profile/i.test(message)) return CONNECT_UNAVAILABLE;
    return { ok: false, message: "Stripe could not be reached just now. Please try again in a minute." };
  }
}

/**
 * Mirror the connected account's state from Stripe.
 *
 * Called when the client lands back from onboarding, because the webhook
 * that would carry the same fact may arrive later, or not at all on a
 * deployment with no Connect endpoint. Re-fetched rather than inferred from
 * the return: coming back from Stripe proves nothing about what they did there.
 */
export async function refreshStripeAccount(
  db: Database,
  ctx: TenantContext,
): Promise<ConnectedAccountStatus | null> {
  if (!stripeConfigured()) return null;
  const site = await shopSiteFor(db, ctx);
  if (!site) return null;
  const row = await settingsRow(db, ctx, site.id);
  if (!row?.stripeAccountId) return null;

  let account: Stripe.Account;
  try {
    account = await requireStripe().accounts.retrieve(row.stripeAccountId);
  } catch (error) {
    console.error("[shop] could not read the connected account", {
      account: row.stripeAccountId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return null;
  }

  const status = accountStatusOf(account);
  await mirrorChargesEnabled(db, row.stripeAccountId, status.chargesEnabled);
  return status;
}

/**
 * Write what Stripe says about an account onto the shop that uses it.
 *
 * Shared by the return-from-onboarding refresh and the Connect webhook, so
 * the two cannot disagree about what "connected" means. Keyed by account id,
 * not tenant: the webhook has no session.
 */
export async function mirrorChargesEnabled(
  db: Database,
  stripeAccountId: string,
  chargesEnabled: boolean,
): Promise<number> {
  const updated = await db
    .update(shopSettings)
    .set({ chargesEnabled, updatedAt: new Date() })
    .where(eq(shopSettings.stripeAccountId, stripeAccountId))
    .returning({ id: shopSettings.id });
  return updated.length;
}
