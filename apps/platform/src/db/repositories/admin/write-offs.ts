import { and, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, clients, expenses, organizations } from "@/db/schema";
import {
  summarizeWriteOffs,
  type CategoryTotal,
  type WriteOffSummary,
} from "@/lib/finance/write-offs";
import type { AdminContext } from "../context";
import { yearRange, type LedgerCategory } from "./finance";

/**
 * The data behind "Potential write-offs" on the payments page.
 *
 * Expenses come from the ledger as it stands (deleted rows are not
 * deductions). Free sites are two columns on the client, set and cleared only
 * here and only by an admin, each change written to `audit_log` with what it
 * replaced — a number that may end up on a tax return should be able to say
 * where it came from.
 */

export async function writeOffsForYear(
  _ctx: AdminContext,
  db: Database,
  year: number,
): Promise<WriteOffSummary> {
  const range = yearRange(year);

  const byCategory = await db
    .select({
      category: expenses.category,
      count: sql<number>`count(*)::int`,
      totalCents: sql<number>`coalesce(sum(${expenses.amountCents}), 0)::int`,
    })
    .from(expenses)
    .where(
      and(
        isNull(expenses.deletedAt),
        gte(expenses.occurredOn, range.from),
        lt(expenses.occurredOn, range.to),
      ),
    )
    .groupBy(expenses.category);

  const builds = await db
    .select({
      clientPublicId: clients.publicId,
      organizationName: organizations.name,
      valueCents: clients.freeBuildValueCents,
      builtOn: clients.freeBuildOn,
    })
    .from(clients)
    .innerJoin(organizations, eq(organizations.id, clients.organizationId))
    .where(
      and(
        eq(clients.isInternal, false),
        isNotNull(clients.freeBuildValueCents),
        gte(clients.freeBuildOn, range.from),
        lt(clients.freeBuildOn, range.to),
      ),
    );

  const categories: CategoryTotal[] = byCategory.map((row) => ({
    category: row.category as LedgerCategory,
    count: Number(row.count),
    totalCents: Number(row.totalCents),
  }));

  return summarizeWriteOffs(
    year,
    categories,
    builds.map((b) => ({
      clientPublicId: b.clientPublicId,
      organizationName: b.organizationName,
      valueCents: b.valueCents!,
      builtOn: b.builtOn!,
    })),
  );
}

/** Clients a free site can be added for: current, not the agency's own, not already listed. */
export async function freeBuildCandidates(
  _ctx: AdminContext,
  db: Database,
): Promise<{ clientPublicId: string; organizationName: string }[]> {
  return db
    .select({ clientPublicId: clients.publicId, organizationName: organizations.name })
    .from(clients)
    .innerJoin(organizations, eq(organizations.id, clients.organizationId))
    .where(
      and(
        eq(clients.isInternal, false),
        isNull(clients.archivedAt),
        isNull(clients.freeBuildValueCents),
      ),
    )
    .orderBy(organizations.name);
}

function isRealDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

async function findClient(db: Database, clientPublicId: string) {
  const [row] = await db
    .select({
      id: clients.id,
      organizationId: clients.organizationId,
      valueCents: clients.freeBuildValueCents,
      builtOn: clients.freeBuildOn,
    })
    .from(clients)
    .where(and(eq(clients.publicId, clientPublicId), eq(clients.isInternal, false)))
    .limit(1);
  return row ?? null;
}

export type SetFreeBuildResult =
  | { ok: true; created: boolean }
  | { ok: false; reason: "not_found" };

/** Add a free site for a client, or change its value or date. */
export async function setFreeBuild(
  ctx: AdminContext,
  db: Database,
  clientPublicId: string,
  input: { valueCents: number; builtOn: string },
): Promise<SetFreeBuildResult> {
  if (!Number.isInteger(input.valueCents) || input.valueCents <= 0) {
    throw new Error("Value must be a positive whole number of cents.");
  }
  if (!isRealDate(input.builtOn)) throw new Error("Built-on date must be a real YYYY-MM-DD date.");

  const client = await findClient(db, clientPublicId);
  if (!client) return { ok: false, reason: "not_found" };

  await db
    .update(clients)
    .set({ freeBuildValueCents: input.valueCents, freeBuildOn: input.builtOn, updatedAt: new Date() })
    .where(eq(clients.id, client.id));

  const created = client.valueCents === null;
  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: client.organizationId,
    action: "client.free_build_set",
    entityType: "client",
    entityId: clientPublicId,
    metadata: {
      valueCents: input.valueCents,
      builtOn: input.builtOn,
      previous: created ? null : { valueCents: client.valueCents, builtOn: client.builtOn },
    },
  });

  return { ok: true, created };
}

export type ClearFreeBuildResult =
  | { ok: true; cleared: boolean }
  | { ok: false; reason: "not_found" };

/** Take a client off the free-sites list. */
export async function clearFreeBuild(
  ctx: AdminContext,
  db: Database,
  clientPublicId: string,
): Promise<ClearFreeBuildResult> {
  const client = await findClient(db, clientPublicId);
  if (!client) return { ok: false, reason: "not_found" };
  if (client.valueCents === null) return { ok: true, cleared: false };

  await db
    .update(clients)
    .set({ freeBuildValueCents: null, freeBuildOn: null, updatedAt: new Date() })
    .where(eq(clients.id, client.id));

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: client.organizationId,
    action: "client.free_build_cleared",
    entityType: "client",
    entityId: clientPublicId,
    metadata: { previous: { valueCents: client.valueCents, builtOn: client.builtOn } },
  });

  return { ok: true, cleared: true };
}
