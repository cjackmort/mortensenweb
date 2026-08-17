import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  changeAllowances,
  clients,
  servicePlans,
  subscriptions,
} from "@/db/schema";
import { currentPeriod, periodLabel, type BillingPeriod } from "@/lib/billing/period";
import { type TenantContext } from "../context";

/**
 * What a client is currently entitled to do.
 *
 * Two separate questions live here and they are deliberately not merged:
 *
 *  1. **Is the feature unlocked?** Answered by a timestamp on `clients`, set
 *     when the first payment is confirmed. This is about the commercial
 *     relationship having started at all.
 *  2. **Is there allowance left this month?** Answered by `change_allowances`.
 *     This is about usage within a relationship that already exists.
 *
 * Collapsing them into one "can they?" boolean loses the ability to say *why*
 * not — and "you haven't paid yet" and "you've used all three of your changes"
 * need completely different screens.
 */

// ---------------------------------------------------------------------------
// Feature unlocks
// ---------------------------------------------------------------------------

export interface Entitlements {
  analyticsUnlocked: boolean;
  changeRequestsUnlocked: boolean;
  /** The plan they are on, when there is an active subscription. */
  planKey: string | null;
  planName: string | null;
  monthlyPriceCents: number | null;
  includedChangesPerMonth: number | null;
  overagePerChangeCents: number | null;
  planIncludesAnalytics: boolean;
  squarePlanVariationId: string | null;
  /** Whether the client has switched on automatic monthly payment. */
  recurringEnabled: boolean;
}

/**
 * Read one tenant's entitlements.
 *
 * Takes a `TenantContext` and filters on it, like every other client-facing
 * repository function — this is read by the client's own dashboard, so it
 * cannot be a cross-tenant primitive.
 */
export async function getEntitlements(
  db: Database,
  ctx: TenantContext,
): Promise<Entitlements | null> {
  const rows = await db
    .select({
      analyticsUnlockedAt: clients.analyticsUnlockedAt,
      changeRequestsUnlockedAt: clients.changeRequestsUnlockedAt,
      planKey: servicePlans.key,
      planName: servicePlans.name,
      includedChangesPerMonth: servicePlans.includedChangesPerMonth,
      overagePerChangeCents: servicePlans.overagePerChangeCents,
      planIncludesAnalytics: servicePlans.includesAnalytics,
      squarePlanVariationId: servicePlans.squarePlanVariationId,
      monthlyPriceCents: subscriptions.monthlyPriceCents,
      recurringEnabledAt: subscriptions.recurringEnabledAt,
    })
    .from(clients)
    .leftJoin(
      subscriptions,
      and(
        eq(subscriptions.clientId, clients.id),
        eq(subscriptions.status, "active"),
      ),
    )
    .leftJoin(servicePlans, eq(servicePlans.id, subscriptions.planId))
    .where(eq(clients.organizationId, ctx.organizationId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    analyticsUnlocked: row.analyticsUnlockedAt !== null,
    changeRequestsUnlocked: row.changeRequestsUnlockedAt !== null,
    planKey: row.planKey,
    planName: row.planName,
    monthlyPriceCents: row.monthlyPriceCents,
    includedChangesPerMonth: row.includedChangesPerMonth,
    overagePerChangeCents: row.overagePerChangeCents,
    planIncludesAnalytics: row.planIncludesAnalytics ?? true,
    squarePlanVariationId: row.squarePlanVariationId,
    recurringEnabled: row.recurringEnabledAt !== null,
  };
}

// ---------------------------------------------------------------------------
// Allowance
// ---------------------------------------------------------------------------

export interface AllowanceState {
  period: BillingPeriod;
  label: string;
  /** Null means unlimited. */
  included: number | null;
  used: number;
  /** Null when unlimited. Never negative. */
  remaining: number | null;
  /** What one more change would cost, when the allowance is spent. */
  overagePerChangeCents: number | null;
}

/**
 * The allowance as it stands, without changing anything.
 *
 * Read-only on purpose: this backs the "2 of 3 changes left" counter, and a
 * page load must never create or consume anything. The row is created lazily
 * by `consumeChange`, so a client who has submitted nothing this month simply
 * has no row and reads as fully unused.
 */
export async function getAllowance(
  db: Database,
  ctx: TenantContext,
  at: Date = new Date(),
): Promise<AllowanceState | null> {
  const period = currentPeriod(at);

  const rows = await db
    .select({
      clientId: clients.id,
      included: servicePlans.includedChangesPerMonth,
      overagePerChangeCents: servicePlans.overagePerChangeCents,
    })
    .from(clients)
    .leftJoin(
      subscriptions,
      and(
        eq(subscriptions.clientId, clients.id),
        eq(subscriptions.status, "active"),
      ),
    )
    .leftJoin(servicePlans, eq(servicePlans.id, subscriptions.planId))
    .where(eq(clients.organizationId, ctx.organizationId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const existing = await db
    .select({ included: changeAllowances.included, used: changeAllowances.used })
    .from(changeAllowances)
    .where(
      and(
        eq(changeAllowances.clientId, row.clientId),
        eq(changeAllowances.periodStart, period.start),
      ),
    )
    .limit(1);

  // The stored `included` wins where a row exists: it was copied from the plan
  // when the period opened, and a plan change mid-month must not retroactively
  // alter an allowance that has already been partly spent.
  const included = existing[0]
    ? existing[0].included
    : (row.included ?? null);
  const used = existing[0]?.used ?? 0;

  return {
    period,
    label: periodLabel(period),
    included,
    used,
    remaining: included === null ? null : Math.max(0, included - used),
    overagePerChangeCents: row.overagePerChangeCents,
  };
}

export type ConsumeOutcome =
  | { ok: true; treatment: "included"; allowanceId: string; remaining: number | null }
  | {
      ok: false;
      reason: "exhausted";
      allowanceId: string;
      included: number;
      overagePerChangeCents: number | null;
    }
  | { ok: false; reason: "no_client" };

/**
 * Spend one change from this month's allowance.
 *
 * The upsert-with-`setWhere` is the whole point, and it is the same shape as
 * `claimDispatchSlot`:
 *
 *   INSERT … VALUES (used = 1)
 *   ON CONFLICT (client, period) DO UPDATE SET used = used + 1
 *     WHERE used < included
 *
 * One statement, so the read and the write cannot be separated. Two submissions
 * arriving milliseconds apart cannot both see "two used of three" and both
 * write three. When the row is already at its limit the update matches nothing,
 * returns no rows, and the caller is told the allowance is spent — which is the
 * moment the client is offered an upgrade or a per-change charge.
 *
 * Unlimited plans (`included IS NULL`) still increment, because the count is
 * worth having even when nothing is enforced against it.
 */
export async function consumeChange(
  db: Database,
  ctx: TenantContext,
  at: Date = new Date(),
): Promise<ConsumeOutcome> {
  const period = currentPeriod(at);

  const rows = await db
    .select({
      clientId: clients.id,
      subscriptionId: subscriptions.id,
      included: servicePlans.includedChangesPerMonth,
      overagePerChangeCents: servicePlans.overagePerChangeCents,
    })
    .from(clients)
    .leftJoin(
      subscriptions,
      and(
        eq(subscriptions.clientId, clients.id),
        eq(subscriptions.status, "active"),
      ),
    )
    .leftJoin(servicePlans, eq(servicePlans.id, subscriptions.planId))
    .where(eq(clients.organizationId, ctx.organizationId))
    .limit(1);

  const row = rows[0];
  if (!row) return { ok: false, reason: "no_client" };

  const claimed = await db
    .insert(changeAllowances)
    .values({
      clientId: row.clientId,
      subscriptionId: row.subscriptionId,
      periodStart: period.start,
      periodEnd: period.end,
      included: row.included,
      used: 1,
    })
    .onConflictDoUpdate({
      target: [changeAllowances.clientId, changeAllowances.periodStart],
      set: { used: sql`${changeAllowances.used} + 1` },
      // NULL `included` means unlimited, and `used < NULL` is NULL rather than
      // true — so it has to be spelled out, or every unlimited client would be
      // refused on their second change of the month.
      setWhere: sql`${changeAllowances.included} IS NULL OR ${changeAllowances.used} < ${changeAllowances.included}`,
    })
    .returning({
      id: changeAllowances.id,
      used: changeAllowances.used,
      included: changeAllowances.included,
    });

  const granted = claimed[0];
  if (granted) {
    return {
      ok: true,
      treatment: "included",
      allowanceId: granted.id,
      remaining:
        granted.included === null
          ? null
          : Math.max(0, granted.included - granted.used),
    };
  }

  // Refused. Report the real numbers so the UI can say "you've used all 3 of
  // your changes this month" rather than something evasive.
  const current = await db
    .select({ id: changeAllowances.id, included: changeAllowances.included })
    .from(changeAllowances)
    .where(
      and(
        eq(changeAllowances.clientId, row.clientId),
        eq(changeAllowances.periodStart, period.start),
      ),
    )
    .limit(1);

  return {
    ok: false,
    reason: "exhausted",
    allowanceId: current[0]?.id ?? "",
    included: current[0]?.included ?? row.included ?? 0,
    overagePerChangeCents: row.overagePerChangeCents,
  };
}

/**
 * Hand a spent change back.
 *
 * Called when a submission fails after the allowance was claimed — the same
 * reasoning as `releaseDispatchSlot`. Charging someone for a change that was
 * never created is a billing error the client will notice and we would not.
 *
 * Floored at zero because the table refuses a negative count.
 */
export async function refundChange(
  db: Database,
  allowanceId: string,
): Promise<void> {
  await db
    .update(changeAllowances)
    .set({ used: sql`GREATEST(${changeAllowances.used} - 1, 0)` })
    .where(eq(changeAllowances.id, allowanceId));
}

/** Allowance history, newest first. Backs "your recent months" on billing. */
export async function listAllowanceHistory(
  db: Database,
  ctx: TenantContext,
  limit = 6,
) {
  return db
    .select({
      periodStart: changeAllowances.periodStart,
      periodEnd: changeAllowances.periodEnd,
      included: changeAllowances.included,
      used: changeAllowances.used,
    })
    .from(changeAllowances)
    .innerJoin(clients, eq(clients.id, changeAllowances.clientId))
    .where(eq(clients.organizationId, ctx.organizationId))
    .orderBy(desc(changeAllowances.periodStart))
    .limit(limit);
}
