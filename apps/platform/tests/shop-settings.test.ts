import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import type { Database } from "@/db/client";
import { auditLog, shopSettings, sites } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { growthAccess } from "@/lib/growth/access";
import { AuthorizationError, tenantContextFrom } from "@/db/repositories/context";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * Shop settings: where the money goes, and how orders reach customers.
 *
 * What would go wrong quietly: a second press of "Connect Stripe" making a
 * second account; a return from Stripe being taken as proof of anything; a
 * shipping rate typed in cents charging a hundred times over; a pickup shop
 * keeping a shipping charge; another tenant reaching this one's account; and
 * an unbuilt feature opening for a client who was merely comped.
 */

const stripeState = {
  accounts: new Map<string, Stripe.Account>(),
  created: 0,
  links: [] as Stripe.AccountLinkCreateParams[],
  /** What Stripe answers the next `accounts.create` with, when it refuses. */
  createError: null as Error | null,
};

vi.mock("@/lib/payments/stripe", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments/stripe")>("@/lib/payments/stripe");
  return {
    ...actual,
    requireStripe: () =>
      ({
        accounts: {
          create: async () => {
            if (stripeState.createError) throw stripeState.createError;
            stripeState.created += 1;
            const account = {
              id: `acct_test${stripeState.created}`,
              object: "account",
              charges_enabled: false,
              details_submitted: false,
              payouts_enabled: false,
            } as Stripe.Account;
            stripeState.accounts.set(account.id, account);
            return account;
          },
          retrieve: async (id: string) => {
            const found = stripeState.accounts.get(id);
            if (!found) throw new Error(`no such account ${id}`);
            return found;
          },
        },
        accountLinks: {
          create: async (params: Stripe.AccountLinkCreateParams) => {
            stripeState.links.push(params);
            return { url: `https://connect.stripe.com/setup/${params.account}` };
          },
        },
      }) as never,
  };
});

const { getShopSettings, refreshStripeAccount, saveShopSettings, startStripeConnect, shopSiteFor } =
  await import("@/db/repositories/client/shop-settings");
const { parseDollars } = await import("@/lib/shop/money");
const { canUseFeature } = await import("@/db/repositories/client/growth");

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let globex: SeededTenant;

async function addSite(tenant: SeededTenant, status: "draft" | "preview" | "live", name = "site") {
  const [row] = await db
    .insert(sites)
    .values({
      publicId: newPublicId(),
      organizationId: tenant.organizationId,
      name: `${name}-${newPublicId().slice(0, 6).toLowerCase()}`,
      status,
    })
    .returning({ id: sites.id, name: sites.name });
  return row!;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  acme = await seedTenant(db, "Acme");
  globex = await seedTenant(db, "Globex");
});

afterAll(async () => {
  await close();
});

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_shop");
  vi.stubEnv("AUTH_URL", "https://portal.example.test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const defaultInput = {
  fulfilment: "ship",
  shipping: "8.50",
  taxEnabled: false,
  refundPolicy: "",
  shippingPolicy: "",
};

describe("dollars typed by a person", () => {
  it("reads the usual ways of writing an amount, and refuses the rest", () => {
    expect(parseDollars("8.50")).toBe(850);
    expect(parseDollars("8")).toBe(800);
    expect(parseDollars("$8.5")).toBe(850);
    expect(parseDollars(" 1,250.00 ")).toBe(125000);
    expect(parseDollars("0")).toBe(0);
    expect(parseDollars("")).toBeNull();
    expect(parseDollars("eight")).toBeNull();
    expect(parseDollars("8.505")).toBeNull();
    expect(parseDollars("-8")).toBeNull();
  });
});

describe("before anything is saved", () => {
  it("has no shop for a tenant with no website", async () => {
    expect(await getShopSettings(db, globex.ctx)).toBeNull();
    const saved = await saveShopSettings(db, globex.ctx, defaultInput);
    expect(saved.ok).toBe(false);
    const started = await startStripeConnect(db, globex.ctx);
    expect(started.ok).toBe(false);
  });

  it("shows the defaults without writing a row", async () => {
    const site = await addSite(acme, "live");
    const view = await getShopSettings(db, acme.ctx);
    expect(view).toMatchObject({
      siteName: site.name,
      stripeAccountId: null,
      chargesEnabled: false,
      fulfilment: "ship",
      shippingCents: 0,
      taxEnabled: false,
      updatedAt: null,
    });
    const rows = await db.select().from(shopSettings).where(eq(shopSettings.organizationId, acme.organizationId));
    expect(rows).toHaveLength(0);
  });

  it("puts the shop on the site furthest along", async () => {
    const tenant = await seedTenant(db, "Initech");
    await addSite(tenant, "draft", "draft");
    const preview = await addSite(tenant, "preview", "preview");
    expect((await shopSiteFor(db, tenant.ctx))?.id).toBe(preview.id);
    const live = await addSite(tenant, "live", "live");
    expect((await shopSiteFor(db, tenant.ctx))?.id).toBe(live.id);
  });
});

describe("how orders reach customers", () => {
  it("saves a shipping rate in cents and records who changed it", async () => {
    const result = await saveShopSettings(db, acme.ctx, { ...defaultInput, shipping: "12.00", taxEnabled: true });
    expect(result.ok).toBe(true);

    const view = (await getShopSettings(db, acme.ctx))!;
    expect(view.shippingCents).toBe(1200);
    expect(view.taxEnabled).toBe(true);
    expect(view.updatedAt).not.toBeNull();

    const audits = await db.select().from(auditLog).where(eq(auditLog.organizationId, acme.organizationId));
    expect(audits.some((a) => a.action === "shop.settings_saved" && a.actorUserId === acme.userId)).toBe(true);
  });

  it("charges no shipping on a pickup shop, whatever the rate field says", async () => {
    const result = await saveShopSettings(db, acme.ctx, { ...defaultInput, fulfilment: "pickup", shipping: "12.00" });
    expect(result.ok).toBe(true);
    const view = (await getShopSettings(db, acme.ctx))!;
    expect(view.fulfilment).toBe("pickup");
    expect(view.shippingCents).toBe(0);
  });

  it("refuses a rate it cannot read, one typed in cents, and a way of fulfilling it does not know", async () => {
    expect((await saveShopSettings(db, acme.ctx, { ...defaultInput, shipping: "about ten" })).ok).toBe(false);
    expect((await saveShopSettings(db, acme.ctx, { ...defaultInput, shipping: "850" })).ok).toBe(false);
    expect((await saveShopSettings(db, acme.ctx, { ...defaultInput, fulfilment: "courier" })).ok).toBe(false);
    expect((await saveShopSettings(db, acme.ctx, { ...defaultInput, refundPolicy: "x".repeat(2001) })).ok).toBe(false);
  });

  it("keeps the policies as written, trimmed, and treats blank as none", async () => {
    await saveShopSettings(db, acme.ctx, { ...defaultInput, refundPolicy: "  14 days.  ", shippingPolicy: "   " });
    const view = (await getShopSettings(db, acme.ctx))!;
    expect(view.refundPolicy).toBe("14 days.");
    expect(view.shippingPolicy).toBeNull();
  });

  it("is read-only while an operator is viewing as the client", async () => {
    const viewing = tenantContextFrom(
      { userId: acme.userId, organizationId: acme.organizationId, role: "admin", status: "active", sessionEpoch: 0 },
      acme.organizationId,
      { impersonating: true },
    );
    await expect(saveShopSettings(db, viewing, defaultInput)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(startStripeConnect(db, viewing)).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("connecting Stripe", () => {
  it("creates one account, stores it, and sends the client to Stripe", async () => {
    const first = await startStripeConnect(db, acme.ctx);
    expect(first).toMatchObject({ ok: true, url: "https://connect.stripe.com/setup/acct_test1" });
    expect(stripeState.created).toBe(1);

    const view = (await getShopSettings(db, acme.ctx))!;
    expect(view.stripeAccountId).toBe("acct_test1");
    // An account id is not a connection. Stripe has not said it will take money.
    expect(view.chargesEnabled).toBe(false);

    const link = stripeState.links.at(-1)!;
    expect(link.type).toBe("account_onboarding");
    expect(link.return_url).toBe("https://portal.example.test/dashboard/growth/shop/settings?stripe=return");
    expect(link.refresh_url).toBe("https://portal.example.test/dashboard/growth/shop/settings?stripe=refresh");
  });

  it("says Connect is not switched on when Stripe wants the platform's profile first, not 'try again'", async () => {
    const initech = await seedTenant(db, "Initech");
    await addSite(initech, "live");
    stripeState.createError = new Error(
      "You must complete your platform profile to use Connect and create live connected accounts. Visit your dashboard at https://dashboard.stripe.com/connect/accounts/overview to answer the questionnaire.",
    );
    try {
      const refused = await startStripeConnect(db, initech.ctx);
      expect(refused).toMatchObject({ ok: false, message: expect.stringMatching(/not switched on here yet/) });
      expect(stripeState.created).toBe(1);
      expect((await getShopSettings(db, initech.ctx))!.stripeAccountId).toBeNull();
    } finally {
      stripeState.createError = null;
    }
  });

  it("continues the same onboarding on a second press rather than making a second account", async () => {
    const again = await startStripeConnect(db, acme.ctx);
    expect(again).toMatchObject({ ok: true, url: "https://connect.stripe.com/setup/acct_test1" });
    expect(stripeState.created).toBe(1);
    expect(stripeState.links).toHaveLength(2);
  });

  it("keeps the fulfilment settings the client already saved", async () => {
    const view = (await getShopSettings(db, acme.ctx))!;
    expect(view.refundPolicy).toBe("14 days.");
    expect(view.shippingCents).toBe(850);
  });

  it("takes the return from Stripe as a reason to ask Stripe, not as proof", async () => {
    const before = await refreshStripeAccount(db, acme.ctx);
    expect(before).toEqual({ chargesEnabled: false, detailsSubmitted: false, payoutsEnabled: false });
    expect((await getShopSettings(db, acme.ctx))!.chargesEnabled).toBe(false);

    stripeState.accounts.set("acct_test1", {
      ...stripeState.accounts.get("acct_test1")!,
      charges_enabled: true,
      details_submitted: true,
      payouts_enabled: true,
    });
    const after = await refreshStripeAccount(db, acme.ctx);
    expect(after?.chargesEnabled).toBe(true);
    expect((await getShopSettings(db, acme.ctx))!.chargesEnabled).toBe(true);
  });

  it("will not start onboarding again once payments are on", async () => {
    const result = await startStripeConnect(db, acme.ctx);
    expect(result).toMatchObject({ ok: false });
    expect(stripeState.created).toBe(1);
  });

  it("is another tenant's business to nobody else", async () => {
    await addSite(globex, "live");
    const theirs = (await getShopSettings(db, globex.ctx))!;
    expect(theirs.stripeAccountId).toBeNull();
    expect(theirs.chargesEnabled).toBe(false);
  });

  it("refuses in words when Stripe or the portal's own address is not configured", async () => {
    const tenant = await seedTenant(db, "Umbrella");
    await addSite(tenant, "live");

    vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect(await startStripeConnect(db, tenant.ctx)).toMatchObject({ ok: false });
    expect(await refreshStripeAccount(db, tenant.ctx)).toBeNull();

    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_shop");
    vi.stubEnv("AUTH_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    expect(await startStripeConnect(db, tenant.ctx)).toMatchObject({ ok: false });
    expect(stripeState.created).toBe(1);
  });
});

describe("opening a feature that is still being built", () => {
  const comped = growthAccess({ planKey: null, comped: true, addOns: [] });
  const nobody = growthAccess({ planKey: null, comped: false, addOns: [] });
  const state = (access: typeof comped, earlyAccess: boolean) =>
    ({
      access,
      planKey: null,
      planName: null,
      monthlyPriceCents: null,
      billing: "complimentary" as const,
      cancelsOn: null,
      renewsOn: null,
      addOns: [],
      earlyAccess,
      // Not a store: the shop opening for one is `client-kinds.test.ts`.
      shopEnabled: false,
      bookingEnabled: false,
    });

  it("opens for the agency's own site, and for nobody else — not even a comp", () => {
    const shop = comped.find((a) => a.feature.key === "shop")!;
    expect(shop.via).toBe("comp");
    if (shop.feature.available) return; // Shipped since this was written; nothing to gate.
    expect(canUseFeature(state(comped, true), "shop")).toBe(true);
    expect(canUseFeature(state(comped, false), "shop")).toBe(false);
  });

  it("never opens a feature the client does not have, early access or not", () => {
    expect(canUseFeature(state(nobody, true), "reviews")).toBe(false);
  });

  it("gives everyone the free shop, but opens it early only with early access", () => {
    const shop = nobody.find((a) => a.feature.key === "shop")!;
    expect(shop.via).toBe("free");
    if (shop.feature.available) return; // Shipped since this was written; nothing to gate.
    expect(canUseFeature(state(nobody, true), "shop")).toBe(true);
    expect(canUseFeature(state(nobody, false), "shop")).toBe(false);
  });
});
