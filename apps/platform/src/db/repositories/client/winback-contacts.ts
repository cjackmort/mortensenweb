import { and, asc, count, desc, eq, isNull, notExists, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { eventBookings, leads, winbackContacts, winbackSuppressions } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { isEmailAddress } from "@/lib/growth/lead-reply";
import { normaliseEmail, type ImportedContact } from "@/lib/winback/csv";
import { formatDateWithYear } from "@/lib/time";
import { assertMutable, NotFoundError, type TenantContext } from "../context";
import type { LeadStatus } from "./leads";

/**
 * A business's past customers, tenant-scoped.
 *
 * Every query filters on `ctx.organizationId`; a public id from another
 * tenant is `NotFoundError`, indistinguishable from one that never existed.
 */

export interface ContactRow {
  publicId: string;
  email: string;
  name: string | null;
  source: "lead" | "import" | "manual";
  howBecameCustomer: string;
  lastJobOn: string | null;
  /** Why they will not be emailed, or null when they will. */
  suppressed: string | null;
  createdAt: Date;
}

const PAGE_SIZE = 100;
/** Inserted per statement: comfortably under Postgres's parameter limit. */
const INSERT_CHUNK = 500;

function suppressionFor(organizationId: string) {
  // Correlated on purpose, and qualified on both sides: Drizzle leaves
  // columns unqualified on a single-table select, which would compare the
  // suppression table with itself and find nobody suppressed.
  return sql<string | null>`(
    select "winback_suppressions"."reason" from "winback_suppressions"
    where "winback_suppressions"."organization_id" = ${organizationId}
      and "winback_suppressions"."email" = "winback_contacts"."email"
    limit 1
  )`;
}

export async function listContacts(
  db: Database,
  ctx: TenantContext,
  { page = 1 }: { page?: number } = {},
): Promise<{ contacts: ContactRow[]; hasMore: boolean; total: number; reachable: number }> {
  const offset = (Math.max(1, Math.floor(page)) - 1) * PAGE_SIZE;
  const rows = await db
    .select({
      publicId: winbackContacts.publicId,
      email: winbackContacts.email,
      name: winbackContacts.name,
      source: winbackContacts.source,
      howBecameCustomer: winbackContacts.howBecameCustomer,
      lastJobOn: winbackContacts.lastJobOn,
      createdAt: winbackContacts.createdAt,
      suppressed: suppressionFor(ctx.organizationId),
    })
    .from(winbackContacts)
    .where(eq(winbackContacts.organizationId, ctx.organizationId))
    .orderBy(desc(winbackContacts.createdAt), asc(winbackContacts.email))
    .limit(PAGE_SIZE + 1)
    .offset(offset);

  const [totals] = await db
    .select({ total: count() })
    .from(winbackContacts)
    .where(eq(winbackContacts.organizationId, ctx.organizationId));
  const reachable = await countReachable(db, ctx.organizationId);

  return {
    hasMore: rows.length > PAGE_SIZE,
    total: totals?.total ?? 0,
    reachable,
    contacts: rows.slice(0, PAGE_SIZE).map((row) => ({
      ...row,
      source: row.source as ContactRow["source"],
    })),
  };
}

/** Customers a campaign approved now would go to. */
export async function countReachable(db: Database, organizationId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(winbackContacts)
    .where(
      and(
        eq(winbackContacts.organizationId, organizationId),
        notExists(
          db
            .select({ one: sql`1` })
            .from(winbackSuppressions)
            .where(
              and(
                eq(winbackSuppressions.organizationId, organizationId),
                sql`"winback_suppressions"."email" = "winback_contacts"."email"`,
              ),
            ),
        ),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Enquiries that became a booking — a band a venue booked — are marked won
 * too, but the performer is not the business's customer and must never get
 * its offers. Qualified on both sides, for the reason `suppressionFor` gives.
 */
const NOT_A_BOOKING = sql`not exists (
  select 1 from "event_bookings" where "event_bookings"."lead_id" = "leads"."id"
)`;

function wonNote(receivedAt: Date): string {
  return `Won enquiry from your website, ${formatDateWithYear(receivedAt)}`;
}

/**
 * Keep the list in step with the leads inbox, called after a status change.
 *
 * Marked won: they are a customer, recorded now — not read back from the
 * inbox later, because the inbox keeps only its newest ten and archives the
 * rest, which overwrites "won". Moved from won to lost, new or contacted: the
 * client changed their mind, so the customer the inbox added goes. Archived
 * changes nothing, for the same reason.
 */
export async function recordLeadOutcome(
  db: Database,
  ctx: TenantContext,
  leadPublicId: string,
  status: LeadStatus,
): Promise<void> {
  assertMutable(ctx);
  if (status === "archived") return;

  const [lead] = await db
    .select({ id: leads.id, email: leads.email, name: leads.name, receivedAt: leads.receivedAt })
    .from(leads)
    .where(
      and(eq(leads.publicId, leadPublicId), eq(leads.organizationId, ctx.organizationId), isNull(leads.deletedAt)),
    )
    .limit(1);
  if (!lead) return;
  const [booking] = await db.select({ id: eventBookings.id }).from(eventBookings).where(eq(eventBookings.leadId, lead.id)).limit(1);
  if (booking) return;

  if (status !== "won") {
    await forgetLead(db, ctx, lead.id);
    return;
  }

  const email = lead.email ? normaliseEmail(lead.email) : null;
  if (!isEmailAddress(email)) return;
  await db
    .insert(winbackContacts)
    .values({
      publicId: newPublicId(),
      organizationId: ctx.organizationId,
      email,
      name: lead.name?.trim().slice(0, 120) || null,
      source: "lead",
      leadId: lead.id,
      howBecameCustomer: wonNote(lead.receivedAt),
      createdBy: ctx.userId,
    })
    .onConflictDoNothing();
}

/** Called before an enquiry is deleted, while its id can still be found. */
export async function forgetDeletedLead(db: Database, ctx: TenantContext, leadPublicId: string): Promise<void> {
  assertMutable(ctx);
  const [lead] = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.publicId, leadPublicId), eq(leads.organizationId, ctx.organizationId)))
    .limit(1);
  if (lead) await forgetLead(db, ctx, lead.id);
}

/** A deleted enquiry takes the customer it made with it: "remove this person" means removed. */
export async function forgetLead(db: Database, ctx: TenantContext, leadId: string): Promise<void> {
  assertMutable(ctx);
  await db
    .delete(winbackContacts)
    .where(
      and(
        eq(winbackContacts.organizationId, ctx.organizationId),
        eq(winbackContacts.leadId, leadId),
        eq(winbackContacts.source, "lead"),
      ),
    );
}

/** Every enquiry marked won that is not on the list yet — for leads won before this existed. */
export async function syncWonLeads(db: Database, ctx: TenantContext): Promise<{ added: number }> {
  assertMutable(ctx);
  const won = await db
    .select({ id: leads.id, email: leads.email, name: leads.name, receivedAt: leads.receivedAt })
    .from(leads)
    .where(
      and(eq(leads.organizationId, ctx.organizationId), eq(leads.status, "won"), isNull(leads.deletedAt), NOT_A_BOOKING),
    );

  const seen = new Set<string>();
  const values = won.flatMap((lead) => {
    const email = lead.email ? normaliseEmail(lead.email) : null;
    if (!isEmailAddress(email) || seen.has(email)) return [];
    seen.add(email);
    return [
      {
        publicId: newPublicId(),
        organizationId: ctx.organizationId,
        email,
        name: lead.name?.trim().slice(0, 120) || null,
        source: "lead",
        leadId: lead.id,
        howBecameCustomer: wonNote(lead.receivedAt),
        createdBy: ctx.userId,
      },
    ];
  });
  if (values.length === 0) return { added: 0 };

  const inserted = await db
    .insert(winbackContacts)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: winbackContacts.id });
  return { added: inserted.length };
}

export async function importContacts(
  db: Database,
  ctx: TenantContext,
  { fileName, contacts }: { fileName: string; contacts: ImportedContact[] },
  now: Date = new Date(),
): Promise<{ added: number; alreadyHad: number }> {
  assertMutable(ctx);
  const label = fileName.replace(/[\r\n\t]+/g, " ").trim().slice(0, 80) || "a spreadsheet";
  const imported = `Imported from ${label} on ${formatDateWithYear(now)}`;

  let added = 0;
  for (let i = 0; i < contacts.length; i += INSERT_CHUNK) {
    const chunk = contacts.slice(i, i + INSERT_CHUNK);
    const inserted = await db
      .insert(winbackContacts)
      .values(
        chunk.map((c) => ({
          publicId: newPublicId(),
          organizationId: ctx.organizationId,
          email: c.email,
          name: c.name,
          source: "import",
          howBecameCustomer: c.note ? `${imported} · ${c.note}` : imported,
          lastJobOn: c.lastJobOn,
          createdBy: ctx.userId,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: winbackContacts.id });
    added += inserted.length;
  }
  return { added, alreadyHad: contacts.length - added };
}

export async function removeContact(db: Database, ctx: TenantContext, publicId: string): Promise<void> {
  assertMutable(ctx);
  const removed = await db
    .delete(winbackContacts)
    .where(and(eq(winbackContacts.publicId, publicId), eq(winbackContacts.organizationId, ctx.organizationId)))
    .returning({ id: winbackContacts.id });
  if (removed.length === 0) throw new NotFoundError();
}
