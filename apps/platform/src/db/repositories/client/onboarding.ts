import { and, eq, isNull, sql } from "drizzle-orm";
import type { GrowthFeatureKey } from "@mortensenweb/plans";
import type { Database } from "@/db/client";
import { businessProfiles, clientAddOns, clients, connectedAccounts, mediaAssets } from "@/db/schema";
import { growthAccess, hasFeature } from "@/lib/growth/access";
import type { SiteDue } from "@/lib/onboarding/checkout";
import {
  BUSINESS_DETAIL_KEYS,
  onboardingProgress,
  onboardingTodos,
  requiredTodos,
  type OnboardingFacts,
  type OnboardingProgress,
  type OnboardingTodo,
  type OptionalFacts,
  type RequiredFacts,
} from "@/lib/onboarding/todos";
import type { TenantContext } from "../context";
import { getEntitlements, type Entitlements } from "./entitlements";
import { listListingChecklists } from "./listings";
import { siteDueFor } from "./onboarding-checkout";
import { countProducts } from "./shop-products";
import { getShopSettings } from "./shop-settings";

/**
 * The facts behind "Get started", read for one tenant.
 *
 * Every to-do is worked out from what is in the database — the ledger, the
 * business profile, the media library, the listings checklist, connected
 * accounts, the shop — never from a box the client ticked. The list itself
 * is `lib/onboarding/todos.ts`; this only gathers what it needs.
 *
 * Two depths. `loadRequiredFacts` is what the dashboard layout reads on every
 * page to decide whether the "Get started" tab shows; it skips everything
 * that only optional to-dos depend on. The page and the home-page banner read
 * the whole of it.
 */

interface ClientFlags {
  clientId: string;
  compPlanId: string | null;
  isInternal: boolean;
  changeRequestsUnlockedAt: Date | null;
  bookingEnabled: boolean;
  shopEnabled: boolean;
}

async function clientFlags(db: Database, ctx: TenantContext): Promise<ClientFlags | null> {
  const [row] = await db
    .select({
      clientId: clients.id,
      compPlanId: clients.compPlanId,
      isInternal: clients.isInternal,
      changeRequestsUnlockedAt: clients.changeRequestsUnlockedAt,
      bookingEnabled: clients.bookingEnabled,
      shopEnabled: clients.shopEnabled,
    })
    .from(clients)
    .where(eq(clients.organizationId, ctx.organizationId))
    .limit(1);
  return row ?? null;
}

function sitePaymentFrom(due: SiteDue): RequiredFacts["sitePayment"] {
  switch (due.kind) {
    case "none":
      return { state: due.reason === "paid" ? "paid" : "not_needed", amountCents: null };
    case "build":
      return { state: "due", amountCents: due.amountCents };
    case "invoice":
      return {
        state: due.status === "awaiting_confirmation" ? "confirming" : "due",
        amountCents: due.amountCents,
      };
  }
}

async function businessDetails(db: Database, ctx: TenantContext): Promise<Record<string, string>> {
  const [row] = await db
    .select({ details: businessProfiles.details })
    .from(businessProfiles)
    .where(eq(businessProfiles.organizationId, ctx.organizationId))
    .limit(1);
  return row?.details ?? {};
}

/** Whether win-back email is theirs: the one feature that cannot send without a postal address. */
async function hasWinback(db: Database, clientId: string, entitlements: Entitlements | null): Promise<boolean> {
  const addOns = await db
    .select({ featureKey: clientAddOns.featureKey })
    .from(clientAddOns)
    .where(and(eq(clientAddOns.clientId, clientId), isNull(clientAddOns.endedAt)));
  const access = growthAccess({
    planKey: entitlements?.planKey ?? null,
    comped: entitlements?.comped ?? false,
    addOns: addOns.map((a) => a.featureKey as GrowthFeatureKey),
  });
  return hasFeature(access, "winback");
}

async function shopFacts(db: Database, ctx: TenantContext): Promise<RequiredFacts["shop"]> {
  const [settings, products] = await Promise.all([getShopSettings(db, ctx), countProducts(db, ctx)]);
  return { enabled: true, paymentsReady: settings?.chargesEnabled ?? false, productCount: products.total };
}

const NO_SHOP: RequiredFacts["shop"] = { enabled: false, paymentsReady: false, productCount: 0 };

async function requiredFacts(
  db: Database,
  ctx: TenantContext,
  flags: ClientFlags,
  entitlements: Entitlements | null,
  passwordChosen: boolean,
): Promise<RequiredFacts> {
  const [due, details, winback, shop] = await Promise.all([
    siteDueFor(db, flags),
    businessDetails(db, ctx),
    hasWinback(db, flags.clientId, entitlements),
    flags.shopEnabled ? shopFacts(db, ctx) : NO_SHOP,
  ]);

  return {
    passwordChosen,
    sitePayment: sitePaymentFrom(due),
    businessDetailsMissing: BUSINESS_DETAIL_KEYS.filter((key) => !details[key]?.trim()),
    hasAddress: Boolean(details.address?.trim()),
    addressRequired: winback,
    booking: {
      enabled: flags.bookingEnabled,
      // Wired at merge to the availability agent's isAvailabilitySetUp(db, ctx).
      availabilityReady: false,
    },
    shop,
  };
}

async function optionalFacts(
  db: Database,
  ctx: TenantContext,
  entitlements: Entitlements | null,
): Promise<OptionalFacts> {
  const [media, checklists, google] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.organizationId, ctx.organizationId),
          eq(mediaAssets.status, "ready"),
          isNull(mediaAssets.deletedAt),
        ),
      ),
    listListingChecklists(db, ctx),
    db
      .select({ status: connectedAccounts.status })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.organizationId, ctx.organizationId),
          eq(connectedAccounts.provider, "google"),
          isNull(connectedAccounts.revokedAt),
        ),
      )
      .limit(1),
  ]);

  const plan: OptionalFacts["plan"] = entitlements?.comped
    ? { state: "complimentary", name: entitlements.planName }
    : entitlements?.planName
      ? { state: "chosen", name: entitlements.planName }
      : { state: "none", name: null };

  return {
    plan,
    mediaReady: media[0]?.count ?? 0,
    listings:
      checklists.length === 0
        ? null
        : {
            done: checklists.reduce((sum, c) => sum + c.progress.done, 0),
            total: checklists.reduce((sum, c) => sum + c.progress.total, 0),
          },
    searchConsole: !google[0]
      ? "not_connected"
      : google[0].status === "connected"
        ? "connected"
        : "needs_reconnect",
  };
}

export interface LoadOptions {
  /** False only for a session still on its temporary password. */
  passwordChosen: boolean;
}

/** The facts behind the required to-dos. Null when the account has no client record. */
export async function loadRequiredFacts(
  db: Database,
  ctx: TenantContext,
  options: LoadOptions,
): Promise<RequiredFacts | null> {
  const flags = await clientFlags(db, ctx);
  if (!flags) return null;
  const entitlements = await getEntitlements(db, ctx);
  return requiredFacts(db, ctx, flags, entitlements, options.passwordChosen);
}

export async function loadOnboardingFacts(
  db: Database,
  ctx: TenantContext,
  options: LoadOptions,
): Promise<OnboardingFacts | null> {
  const flags = await clientFlags(db, ctx);
  if (!flags) return null;
  const entitlements = await getEntitlements(db, ctx);
  const [required, optional] = await Promise.all([
    requiredFacts(db, ctx, flags, entitlements, options.passwordChosen),
    optionalFacts(db, ctx, entitlements),
  ]);
  return { ...required, ...optional };
}

export interface Onboarding {
  todos: OnboardingTodo[];
  progress: OnboardingProgress;
}

/** The Get started list and its progress. Null when the account has no client record. */
export async function getOnboarding(
  db: Database,
  ctx: TenantContext,
  options: LoadOptions,
): Promise<Onboarding | null> {
  const facts = await loadOnboardingFacts(db, ctx, options);
  if (!facts) return null;
  const todos = onboardingTodos(facts);
  return { todos, progress: onboardingProgress(todos) };
}

/** Whether any required to-do is left: what keeps the "Get started" tab in the nav. */
export async function hasRequiredOnboardingLeft(db: Database, ctx: TenantContext): Promise<boolean> {
  // Only reached from inside the dashboard, which a temporary password never is.
  const facts = await loadRequiredFacts(db, ctx, { passwordChosen: true });
  return facts ? requiredTodos(facts).some((t) => !t.done) : false;
}
