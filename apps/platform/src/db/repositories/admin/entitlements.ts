import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, clients, servicePlans, subscriptions } from "@/db/schema";
import type { AdminContext } from "../context";

/**
 * Granting and withdrawing what a client can use.
 *
 * The trigger in normal operation is a confirmed payment — the first one
 * unlocks analytics and change requests together, which is what the client was
 * promised when they were asked to pay. But the unlock is a separate act from
 * the payment, and lives here rather than being inlined into the ledger, for
 * two reasons:
 *
 *  - a client who paid in cash before the portal existed needs unlocking
 *    without a `payment_requests` row to hang it off;
 *  - a client whose plan does not include analytics must not get analytics just
 *    because they paid.
 *
 * Both are ordinary situations, and neither is expressible if the unlock is a
 * side effect of inserting a ledger row.
 */

export interface UnlockOutcome {
  analyticsUnlocked: boolean;
  changeRequestsUnlocked: boolean;
  /** True when this call is what changed things, false when already unlocked. */
  changed: boolean;
}

/**
 * Unlock a client's paid features.
 *
 * Idempotent, and idempotent in the way that preserves the *first* unlock time:
 * the `IS NULL` guards mean a second confirmed payment does not move the
 * timestamp forward. "When did this client's access begin" should answer the
 * beginning, not the most recent renewal.
 *
 * Analytics is additionally conditional on the plan including it. A client on a
 * hosting-only plan who pays their invoice has bought hosting, and silently
 * handing them a feature they did not buy removes the reason to upgrade.
 */
export async function unlockClientFeatures(
  db: Database,
  clientId: string,
  options: { actorUserId?: string | null; reason: string } = { reason: "payment_confirmed" },
): Promise<UnlockOutcome> {
  const now = new Date();

  const planRows = await db
    .select({
      organizationId: clients.organizationId,
      publicId: clients.publicId,
      analyticsUnlockedAt: clients.analyticsUnlockedAt,
      changeRequestsUnlockedAt: clients.changeRequestsUnlockedAt,
      planIncludesAnalytics: servicePlans.includesAnalytics,
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
    .where(eq(clients.id, clientId))
    .limit(1);

  const row = planRows[0];
  if (!row) {
    return { analyticsUnlocked: false, changeRequestsUnlocked: false, changed: false };
  }

  // No plan on record yet is treated as "analytics included". A client who has
  // paid and has no subscription row is a data gap on our side, and the
  // proportionate response to our own gap is to give them the thing rather
  // than withhold it and make them ask.
  const analyticsAllowed = row.planIncludesAnalytics ?? true;

  const alreadyAnalytics = row.analyticsUnlockedAt !== null;
  const alreadyChanges = row.changeRequestsUnlockedAt !== null;

  const changed =
    (!alreadyChanges) || (analyticsAllowed && !alreadyAnalytics);

  if (changed) {
    await db
      .update(clients)
      .set({
        ...(analyticsAllowed && !alreadyAnalytics
          ? { analyticsUnlockedAt: now }
          : {}),
        ...(alreadyChanges ? {} : { changeRequestsUnlockedAt: now }),
        updatedAt: now,
      })
      .where(eq(clients.id, clientId));

    await db.insert(auditLog).values({
      actorUserId: options.actorUserId ?? null,
      organizationId: row.organizationId,
      action: "entitlements.unlocked",
      entityType: "client",
      entityId: row.publicId,
      metadata: {
        reason: options.reason,
        analytics: analyticsAllowed,
        changeRequests: true,
      },
    });
  }

  return {
    analyticsUnlocked: analyticsAllowed && (alreadyAnalytics || changed),
    changeRequestsUnlocked: alreadyChanges || changed,
    changed,
  };
}

/**
 * Withdraw access by hand.
 *
 * Kept deliberately separate from the dunning ladder, which pauses *labour* and
 * never hosting (§3 of the non-negotiables). This is for the rarer case where
 * access itself has to stop — a disputed chargeback, a client who has left —
 * and it is always an explicit operator act with a recorded reason.
 */
export async function lockClientFeatures(
  ctx: AdminContext,
  db: Database,
  clientId: string,
  reason: string,
): Promise<void> {
  const rows = await db
    .select({ publicId: clients.publicId, organizationId: clients.organizationId })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);

  const row = rows[0];
  if (!row) return;

  await db
    .update(clients)
    .set({
      analyticsUnlockedAt: null,
      changeRequestsUnlockedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(clients.id, clientId));

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: row.organizationId,
    action: "entitlements.locked",
    entityType: "client",
    entityId: row.publicId,
    metadata: { reason },
  });
}

/**
 * Clients who have paid but are still locked.
 *
 * This should always be empty. It exists because it is the query that proves
 * the unlock path is working — a non-empty result means a payment was confirmed
 * and the entitlement did not follow, which is invisible to the operator and
 * infuriating for the client, who paid and still cannot see anything.
 */
export async function listPaidButLockedClients(db: Database) {
  return db
    .select({
      publicId: clients.publicId,
      primaryContactEmail: clients.primaryContactEmail,
    })
    .from(clients)
    .where(
      and(
        isNull(clients.changeRequestsUnlockedAt),
        sql`EXISTS (
          SELECT 1 FROM payments
          WHERE payments.client_id = ${clients.id}
            AND payments.status = 'recorded'
        )`,
      ),
    )
    .limit(50);
}
