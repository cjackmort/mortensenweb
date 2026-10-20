import { and, count, desc, eq, isNull, ne, type SQL } from "drizzle-orm";
import type { Database } from "@/db/client";
import { eventBookings, leads, sites } from "@/db/schema";
import type { LeadField } from "@/lib/growth/netlify-forms";
import { assertMutable, NotFoundError, type TenantContext } from "../context";

/**
 * The client's leads inbox, tenant-scoped.
 *
 * Every query filters on `ctx.organizationId`; a public id from another tenant
 * is `NotFoundError`, indistinguishable from one that never existed.
 */

export const LEAD_STATUSES = ["new", "contacted", "won", "lost", "archived"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export function isLeadStatus(value: unknown): value is LeadStatus {
  return typeof value === "string" && (LEAD_STATUSES as readonly string[]).includes(value);
}

/**
 * The inbox's two tabs. `open` is the inbox itself — every enquiry not
 * archived, whatever the client marked it — and holds the newest
 * `INBOX_SIZE`. `archived` is everything else.
 */
export type LeadView = "open" | "archived";

export function isLeadView(value: unknown): value is LeadView {
  return value === "open" || value === "archived";
}

/**
 * Newest first. `created_at` breaks a tie in `received_at` the same way the
 * inbox's trim does, so the ten shown are the ten kept.
 */
export const INBOX_ORDER = [desc(leads.receivedAt), desc(leads.createdAt), desc(leads.id)] as const;

/**
 * How many enquiries the inbox holds. When another arrives, the oldest is
 * archived — not deleted; it is one tap back from the Archived tab.
 */
export const INBOX_SIZE = 10;

export interface LeadSummary {
  publicId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  /** The first line or so of the message, for the list. */
  preview: string | null;
  status: LeadStatus;
  receivedAt: Date;
  unread: boolean;
  siteName: string;
  /** Which form on the site sent it. A booking form's leads get approve and decline. */
  formName: string | null;
  fields: LeadField[];
}

const PAGE_SIZE = 50;

function viewFilter(view: LeadView): SQL {
  return view === "archived" ? eq(leads.status, "archived") : ne(leads.status, "archived");
}

function previewOf(message: string | null): string | null {
  if (!message) return null;
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
}

export async function listLeads(
  db: Database,
  ctx: TenantContext,
  { view = "open", page = 1 }: { view?: LeadView; page?: number } = {},
): Promise<{ leads: LeadSummary[]; hasMore: boolean }> {
  const offset = (Math.max(1, Math.floor(page)) - 1) * PAGE_SIZE;
  const rows = await db
    .select({
      publicId: leads.publicId,
      name: leads.name,
      email: leads.email,
      phone: leads.phone,
      message: leads.message,
      status: leads.status,
      receivedAt: leads.receivedAt,
      readAt: leads.readAt,
      siteName: sites.name,
      formName: leads.formName,
      fields: leads.fields,
    })
    .from(leads)
    .innerJoin(sites, eq(sites.id, leads.siteId))
    .where(
      and(
        eq(leads.organizationId, ctx.organizationId),
        isNull(leads.deletedAt),
        viewFilter(view),
      ),
    )
    .orderBy(...INBOX_ORDER)
    // One extra row answers "is there another page" without a count query.
    .limit(PAGE_SIZE + 1)
    .offset(offset);

  return {
    hasMore: rows.length > PAGE_SIZE,
    leads: rows.slice(0, PAGE_SIZE).map((row) => ({
      publicId: row.publicId,
      name: row.name,
      email: row.email,
      phone: row.phone,
      preview: previewOf(row.message),
      status: row.status,
      receivedAt: row.receivedAt,
      unread: row.readAt === null,
      siteName: row.siteName,
      formName: row.formName,
      fields: Array.isArray(row.fields) ? (row.fields as LeadField[]) : [],
    })),
  };
}

/** Unread leads, for the badge on the Growth tab. */
export async function countUnreadLeads(db: Database, ctx: TenantContext): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(leads)
    .where(
      and(
        eq(leads.organizationId, ctx.organizationId),
        isNull(leads.deletedAt),
        isNull(leads.readAt),
        // An archived lead nobody opened is not waiting for anyone.
        ne(leads.status, "archived"),
      ),
    );
  return rows[0]?.n ?? 0;
}

export interface LeadDetail extends Omit<LeadSummary, "preview"> {
  message: string | null;
  fields: LeadField[];
  formName: string | null;
  pageUrl: string | null;
  statusChangedAt: Date | null;
}

/**
 * One lead, and mark it read.
 *
 * Opening it *is* reading it — there is no separate "mark as read" for a
 * client to forget. Except while an operator is viewing as the client: that
 * session is read-only everywhere, and an operator checking an inbox must not
 * clear the client's unread count for them.
 */
export async function openLead(
  db: Database,
  ctx: TenantContext,
  publicId: string,
): Promise<LeadDetail> {
  const rows = await db
    .select({
      id: leads.id,
      publicId: leads.publicId,
      name: leads.name,
      email: leads.email,
      phone: leads.phone,
      message: leads.message,
      fields: leads.fields,
      formName: leads.formName,
      pageUrl: leads.pageUrl,
      status: leads.status,
      statusChangedAt: leads.statusChangedAt,
      receivedAt: leads.receivedAt,
      readAt: leads.readAt,
      siteName: sites.name,
    })
    .from(leads)
    .innerJoin(sites, eq(sites.id, leads.siteId))
    .where(
      and(
        eq(leads.publicId, publicId),
        eq(leads.organizationId, ctx.organizationId),
        isNull(leads.deletedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) throw new NotFoundError();

  if (row.readAt === null && !ctx.impersonating) {
    await db
      .update(leads)
      .set({ readAt: new Date() })
      .where(and(eq(leads.id, row.id), isNull(leads.readAt)));
  }

  return {
    publicId: row.publicId,
    name: row.name,
    email: row.email,
    phone: row.phone,
    message: row.message,
    fields: Array.isArray(row.fields) ? (row.fields as LeadField[]) : [],
    formName: row.formName,
    pageUrl: row.pageUrl,
    status: row.status,
    statusChangedAt: row.statusChangedAt,
    receivedAt: row.receivedAt,
    // As it was when they opened it, so the page can say "new".
    unread: row.readAt === null,
    siteName: row.siteName,
  };
}

export async function setLeadStatus(
  db: Database,
  ctx: TenantContext,
  publicId: string,
  status: LeadStatus,
): Promise<void> {
  assertMutable(ctx);
  const now = new Date();
  const updated = await db
    .update(leads)
    .set({ status, statusChangedAt: now, updatedAt: now })
    .where(
      and(
        eq(leads.publicId, publicId),
        eq(leads.organizationId, ctx.organizationId),
        isNull(leads.deletedAt),
      ),
    )
    .returning({ id: leads.id });
  if (updated.length === 0) throw new NotFoundError();
}

/**
 * Delete a lead. Everything personal is erased in place — it is the client's
 * customer's data, and "remove this person" has to mean removed, not hidden.
 * The emptied row is kept only so the backfill cannot import it again.
 *
 * Netlify keeps its own copy; the inbox says so where the button is.
 */
export async function deleteLead(
  db: Database,
  ctx: TenantContext,
  publicId: string,
): Promise<void> {
  assertMutable(ctx);
  const now = new Date();
  const deleted = await db
    .update(leads)
    .set({
      name: null,
      email: null,
      phone: null,
      message: null,
      fields: [],
      pageUrl: null,
      deletedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(leads.publicId, publicId),
        eq(leads.organizationId, ctx.organizationId),
        isNull(leads.deletedAt),
      ),
    )
    .returning({ id: leads.id });
  const leadId = deleted[0]?.id;
  if (!leadId) throw new NotFoundError();

  // A booking request goes with it. An approved show stays on the site — the
  // client published it — but loses the performer's address; a held or
  // declined one was never public, only the person's request, so it goes
  // entirely, off the calendar too.
  await db
    .delete(eventBookings)
    .where(and(eq(eventBookings.leadId, leadId), ne(eventBookings.decision, "approved")));
  await db
    .update(eventBookings)
    .set({ contactEmail: null, updatedAt: now })
    .where(eq(eventBookings.leadId, leadId));
}
