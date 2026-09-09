import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { clients, mediaAssets, mediaDerivatives } from "@/db/schema";
import { DEFAULT_STORAGE_QUOTA_BYTES } from "@/lib/media/constants";
import { type TenantContext } from "../context";

/**
 * Storage quota, enforced atomically.
 *
 * ## Why this is not a SUM
 *
 * The obvious implementation — read `SUM(byte_size)`, compare against the
 * quota, then insert — cannot hold under concurrency, because the read and the
 * write are separate statements and nothing stops two requests from both
 * reading the same total. That is not a theoretical race: measured here at ten
 * simultaneous `beginUpload` calls against room for five, **all ten were
 * granted** and the tenant finished at twice their allowance. Serverless makes
 * simultaneous requests the normal case rather than the unlucky one.
 *
 * `reserveStorage` is a single `UPDATE … WHERE reserved + n <= quota`. Postgres
 * takes a row lock for the update, so the comparison and the increment cannot
 * be separated. When the row is already at its limit the update matches
 * nothing, returns no rows, and the caller is refused. Exactly the shape of
 * `consumeChange` on `change_allowances`, and for exactly the same reason.
 *
 * ## The cost, and how it is paid
 *
 * A counter can drift from the truth it summarises — a process dying between
 * two writes leaves bytes reserved that nothing holds. Left alone that would
 * accumulate into a client who is mysteriously short of room.
 * `reconcileStorageReservations` recomputes the counter from the assets and
 * derivatives themselves, and runs on the scheduled tick. Drift is therefore
 * corrected rather than permanent, which is what makes the counter safe to rely
 * on in the first place.
 */

export type ReserveOutcome =
  | { ok: true; reservedBytes: number; quotaBytes: number }
  | { ok: false; reason: "quota"; freeBytes: number; quotaBytes: number }
  | { ok: false; reason: "no_client" };

/** The effective quota for a tenant: their override, or the platform default. */
const effectiveQuota = sql`COALESCE(${clients.mediaQuotaBytes}, ${DEFAULT_STORAGE_QUOTA_BYTES})`;

/**
 * Claim `bytes` against the tenant's allowance, or refuse.
 *
 * The whole decision is one statement. There is no window between checking and
 * claiming for another request to slip through.
 */
export async function reserveStorage(
  db: Database,
  ctx: TenantContext,
  bytes: number,
): Promise<ReserveOutcome> {
  const claimed = await db
    .update(clients)
    .set({ mediaReservedBytes: sql`${clients.mediaReservedBytes} + ${bytes}` })
    .where(
      and(
        eq(clients.organizationId, ctx.organizationId),
        sql`${clients.mediaReservedBytes} + ${bytes} <= ${effectiveQuota}`,
      ),
    )
    .returning({
      reserved: clients.mediaReservedBytes,
      quota: clients.mediaQuotaBytes,
    });

  const granted = claimed[0];
  if (granted) {
    return {
      ok: true,
      reservedBytes: Number(granted.reserved),
      quotaBytes: Number(granted.quota ?? DEFAULT_STORAGE_QUOTA_BYTES),
    };
  }

  // Refused, or there is no client row at all. Those need different answers:
  // one is "you are out of room", the other is a gap on our side.
  const current = await db
    .select({
      reserved: clients.mediaReservedBytes,
      quota: clients.mediaQuotaBytes,
    })
    .from(clients)
    .where(eq(clients.organizationId, ctx.organizationId))
    .limit(1);

  const row = current[0];
  if (!row) return { ok: false, reason: "no_client" };

  const quotaBytes = Number(row.quota ?? DEFAULT_STORAGE_QUOTA_BYTES);
  return {
    ok: false,
    reason: "quota",
    quotaBytes,
    freeBytes: Math.max(0, quotaBytes - Number(row.reserved)),
  };
}

/**
 * Hand reserved bytes back.
 *
 * Called when a session is abandoned, swept, or completes at a smaller size
 * than it declared. Floored at zero: a double release must not drive the
 * counter negative and hand a tenant unlimited room.
 */
export async function releaseStorage(
  db: Database,
  organizationId: string,
  bytes: number,
): Promise<void> {
  if (bytes <= 0) return;
  await db
    .update(clients)
    .set({
      mediaReservedBytes: sql`GREATEST(${clients.mediaReservedBytes} - ${bytes}, 0)`,
    })
    .where(eq(clients.organizationId, organizationId));
}

/**
 * Adjust a reservation to the size actually stored.
 *
 * A client declares a size before sending, and what arrives can be smaller.
 * Positive delta claims more, negative gives some back — and the claim here is
 * deliberately *unconditional*: the bytes are already in storage, so refusing
 * at this point would leave the counter disagreeing with reality, which is the
 * one thing this design cannot tolerate.
 */
export async function adjustReservation(
  db: Database,
  organizationId: string,
  deltaBytes: number,
): Promise<void> {
  if (deltaBytes === 0) return;
  await db
    .update(clients)
    .set({
      mediaReservedBytes: sql`GREATEST(${clients.mediaReservedBytes} + ${deltaBytes}, 0)`,
    })
    .where(eq(clients.organizationId, organizationId));
}

export interface ReconciliationResult {
  organizationsChecked: number;
  corrected: number;
}

/**
 * Recompute every counter from what is actually stored.
 *
 * This is what makes the counter trustworthy. Without it, any interruption
 * between a release and the write that should have followed leaves bytes
 * reserved forever, and a client slowly loses room for no visible reason.
 *
 * Runs on the scheduled tick. Deliberately a full recomputation rather than an
 * incremental repair: the sum is cheap at this scale, and a repair that is
 * itself incremental can drift in the same way as the thing it repairs.
 */
export async function reconcileStorageReservations(
  db: Database,
): Promise<ReconciliationResult> {
  const truth = await db
    .select({
      organizationId: mediaAssets.organizationId,
      assetBytes: sql<string>`COALESCE(SUM(${mediaAssets.byteSize}), 0)`,
    })
    .from(mediaAssets)
    .groupBy(mediaAssets.organizationId);

  const derivativeTotals = await db
    .select({
      organizationId: mediaAssets.organizationId,
      derivativeBytes: sql<string>`COALESCE(SUM(${mediaDerivatives.byteSize}), 0)`,
    })
    .from(mediaDerivatives)
    .innerJoin(mediaAssets, eq(mediaAssets.id, mediaDerivatives.assetId))
    .groupBy(mediaAssets.organizationId);

  const derivativeByOrg = new Map(
    derivativeTotals.map((row) => [row.organizationId, Number(row.derivativeBytes)]),
  );

  let corrected = 0;

  for (const row of truth) {
    const actual =
      Number(row.assetBytes) + (derivativeByOrg.get(row.organizationId) ?? 0);

    const updated = await db
      .update(clients)
      .set({ mediaReservedBytes: actual })
      .where(
        and(
          eq(clients.organizationId, row.organizationId),
          // Only write when it differs, so the common case costs nothing and
          // the count returned means something.
          sql`${clients.mediaReservedBytes} <> ${actual}`,
        ),
      )
      .returning({ id: clients.id });

    corrected += updated.length;
  }

  // Tenants whose media is entirely gone still need their counter cleared;
  // they have no rows in `truth` at all.
  const emptied = await db
    .update(clients)
    .set({ mediaReservedBytes: 0 })
    .where(
      and(
        sql`${clients.mediaReservedBytes} > 0`,
        sql`NOT EXISTS (
          SELECT 1 FROM "media_assets" a WHERE a."organization_id" = ${clients.organizationId}
        )`,
      ),
    )
    .returning({ id: clients.id });

  return {
    organizationsChecked: truth.length,
    corrected: corrected + emptied.length,
  };
}
