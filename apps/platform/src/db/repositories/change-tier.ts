import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { changeRequests, clients, subscriptions, users } from "@/db/schema";
import { businessTimezone, currentPeriod } from "@/lib/billing/period";

/**
 * Which rules a client's change requests follow (decision D7).
 *
 * - **plan** — the build is paid, they are complimentary or the agency's own,
 *   or a processor charges them for a plan. Their plan's allowance applies,
 *   exactly as before; the size of a change is only a label.
 * - **free** — none of those. Small changes only, one a month, counted by
 *   submission (`freeSmallChangesUsed`).
 *
 * "A plan" means one Stripe actually charges. An operator assigning a plan
 * makes an active subscription row before any money moves, and money is never
 * implied: a hand-billed client becomes `plan` when their build is paid.
 *
 * Not tenant-scoped: it takes a client id the caller resolved — from a session
 * on the requests page, from a request on the dispatch path.
 */

export type ChangeTier =
  | { tier: "plan"; reason: "build_paid" | "complimentary" | "internal" | "paid_plan" }
  | { tier: "free" };

export async function changeTierOf(db: Database, clientId: string): Promise<ChangeTier | null> {
  const [client] = await db
    .select({
      compPlanId: clients.compPlanId,
      isInternal: clients.isInternal,
      buildPaidAt: clients.buildPaidAt,
      changeRequestsUnlockedAt: clients.changeRequestsUnlockedAt,
    })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client) return null;

  if (client.compPlanId) return { tier: "plan", reason: "complimentary" };
  if (client.isInternal) return { tier: "plan", reason: "internal" };
  if (client.buildPaidAt || client.changeRequestsUnlockedAt) return { tier: "plan", reason: "build_paid" };

  const [charged] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(eq(subscriptions.clientId, clientId), eq(subscriptions.status, "active"), isNotNull(subscriptions.provider)),
    )
    .limit(1);
  return charged ? { tier: "plan", reason: "paid_plan" } : { tier: "free" };
}

/** `changeTierOf` for the client of an organization: the dispatch path has only the request's tenant. */
export async function changeTierOfOrganization(db: Database, organizationId: string): Promise<ChangeTier | null> {
  const [client] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.organizationId, organizationId))
    .limit(1);
  return client ? changeTierOf(db, client.id) : null;
}

/**
 * Free small changes a client has used in the business month containing `at`.
 *
 * Counted from the requests themselves rather than an allowance row: a
 * `change_allowances` row copies its limit when the month opens, so a client
 * who used their free change and then bought a plan would be held to one for
 * the rest of the month. The ones that count are small, submitted by the
 * client, and taken as free (`billing = 'courtesy'`, no allowance) — an
 * operator's own courtesy work is not the client's — and not cancelled, which
 * hands the change back exactly as cancelling refunds a plan's.
 *
 * Two submissions in the same instant could both read zero. The one-open-
 * request-per-site rule ahead of this, and the form's idempotency key, make
 * that a second request racing the first rather than a double tap.
 */
export async function freeSmallChangesUsed(db: Database, organizationId: string, at: Date = new Date()): Promise<number> {
  const period = currentPeriod(at);
  const zone = businessTimezone();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(changeRequests)
    .innerJoin(users, eq(users.id, changeRequests.createdByUserId))
    .where(
      and(
        eq(changeRequests.organizationId, organizationId),
        eq(changeRequests.size, "small"),
        eq(changeRequests.billing, "courtesy"),
        eq(users.role, "client"),
        sql`(${changeRequests.createdAt} AT TIME ZONE ${zone})::date BETWEEN ${period.start}::date AND ${period.end}::date`,
        sql`NOT EXISTS (SELECT 1 FROM request_events e WHERE e.request_id = ${changeRequests.id} AND e.kind = 'request_cancelled')`,
      ),
    );
  return Number(row?.count ?? 0);
}
