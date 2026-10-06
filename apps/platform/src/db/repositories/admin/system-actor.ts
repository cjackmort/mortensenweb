import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import type { AdminContext } from "../context";

/**
 * A system actor for payments nobody confirmed by hand.
 *
 * `confirmPaymentReceived` records who confirmed, and the schema requires a
 * named user for `paid`. A webhook has no user, so the operator account stands
 * in — with `metadata.source` on the audit row recording that it was automatic.
 * Attributing it to the person who happened to configure the processor would
 * be worse: the ledger would claim they checked something they never saw.
 */
export async function systemActor(db: Database): Promise<AdminContext | null> {
  const rows = await db.execute(
    sql`select id from users where role = 'admin' and status = 'active' order by created_at limit 1`,
  );
  const id = (rows.rows[0] as { id?: string } | undefined)?.id;
  return id ? ({ userId: id } as AdminContext) : null;
}
