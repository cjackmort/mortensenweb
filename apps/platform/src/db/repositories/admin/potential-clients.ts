import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, prospectContacts, prospects } from "@/db/schema";
import { normaliseSourceUrl } from "./prospects";
import type { AdminContext } from "../context";
import { NotFoundError } from "../context";

/**
 * Potential clients, as the Clients page lists them under the real ones.
 *
 * These are rows in `prospects`, never in `clients`. That is the whole of the
 * separation: billing, monthly reports, MRR, agent dispatch and every client
 * email read `clients` (or the organization behind one), and a prospect has
 * neither, so none of them can count or contact one by mistake. Becoming a
 * client is the explicit "Add a client" step, not a flag flipped here.
 *
 * A prospect can hold several contacts; the operator's form edits the first,
 * which is the one intake creates.
 */

export interface PotentialClient {
  publicId: string;
  businessName: string;
  sourceWebsiteUrl: string | null;
  industry: string | null;
  location: string | null;
  notes: string | null;
  status: string;
  updatedAt: Date;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}

export interface PotentialClientInput {
  businessName: string;
  sourceWebsiteUrl?: string;
  industry?: string;
  location?: string;
  notes?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
}

export type UpdatePotentialClientResult =
  | { ok: true }
  | { ok: false; reason: "invalid_name" | "invalid_url"; message: string };

const PROSPECT_COLUMNS = {
  id: prospects.id,
  publicId: prospects.publicId,
  businessName: prospects.businessName,
  sourceWebsiteUrl: prospects.sourceWebsiteUrl,
  industry: prospects.industry,
  location: prospects.location,
  notes: prospects.notes,
  status: prospects.status,
  updatedAt: prospects.updatedAt,
};

type ProspectRow = { id: string } & Omit<
  PotentialClient,
  "contactName" | "contactEmail" | "contactPhone"
>;

/** An emptied field is stored as null, so "no industry" is never "". */
function optional(value: string | undefined): string | null {
  return value?.trim() || null;
}

type ContactRow = typeof prospectContacts.$inferSelect;

/** The first contact per prospect, keyed by prospect id. */
async function firstContacts(
  db: Database,
  prospectIds: string[],
): Promise<Map<string, ContactRow>> {
  const byProspect = new Map<string, ContactRow>();
  if (prospectIds.length === 0) return byProspect;

  const rows = await db
    .select()
    .from(prospectContacts)
    .where(inArray(prospectContacts.prospectId, prospectIds))
    .orderBy(asc(prospectContacts.createdAt));

  for (const row of rows) {
    if (!byProspect.has(row.prospectId)) byProspect.set(row.prospectId, row);
  }
  return byProspect;
}

function withContact(
  { id: _id, ...prospect }: ProspectRow,
  contact: { name: string | null; email: string | null; phone: string | null } | undefined,
): PotentialClient {
  return {
    ...prospect,
    contactName: contact?.name ?? null,
    contactEmail: contact?.email ?? null,
    contactPhone: contact?.phone ?? null,
  };
}

/**
 * Prospects still being pursued: not removed, and not already converted —
 * a converted one is on the client list above and must not appear twice.
 */
export async function listPotentialClients(
  _ctx: AdminContext,
  db: Database,
): Promise<PotentialClient[]> {
  const rows = await db
    .select(PROSPECT_COLUMNS)
    .from(prospects)
    .where(and(isNull(prospects.archivedAt), ne(prospects.status, "converted")))
    .orderBy(desc(prospects.updatedAt));

  const contacts = await firstContacts(db, rows.map((r) => r.id));
  return rows.map((row) => withContact(row, contacts.get(row.id)));
}

async function findActiveProspect(db: Database, publicId: string): Promise<ProspectRow> {
  const row = (
    await db
      .select(PROSPECT_COLUMNS)
      .from(prospects)
      .where(and(eq(prospects.publicId, publicId), isNull(prospects.archivedAt)))
      .limit(1)
  )[0];
  if (!row) throw new NotFoundError("Potential client not found");
  return row;
}

export async function getPotentialClient(
  _ctx: AdminContext,
  db: Database,
  publicId: string,
): Promise<PotentialClient> {
  const row = await findActiveProspect(db, publicId);
  const contacts = await firstContacts(db, [row.id]);
  return withContact(row, contacts.get(row.id));
}

export async function updatePotentialClient(
  ctx: AdminContext,
  db: Database,
  publicId: string,
  input: PotentialClientInput,
): Promise<UpdatePotentialClientResult> {
  const existing = await findActiveProspect(db, publicId);

  const businessName = input.businessName.trim();
  if (businessName.length < 2) {
    return { ok: false, reason: "invalid_name", message: "A business name is required." };
  }

  let sourceWebsiteUrl: string | null = null;
  if (input.sourceWebsiteUrl?.trim()) {
    sourceWebsiteUrl = normaliseSourceUrl(input.sourceWebsiteUrl);
    if (!sourceWebsiteUrl) {
      return {
        ok: false,
        reason: "invalid_url",
        message: "That doesn't look like a website address.",
      };
    }
  }

  await db
    .update(prospects)
    .set({
      businessName,
      sourceWebsiteUrl,
      industry: optional(input.industry),
      location: optional(input.location),
      notes: optional(input.notes),
      updatedAt: new Date(),
    })
    .where(eq(prospects.id, existing.id));

  const contact = {
    name: optional(input.contactName),
    email: optional(input.contactEmail)?.toLowerCase() ?? null,
    phone: optional(input.contactPhone),
  };
  const current = (await firstContacts(db, [existing.id])).get(existing.id);
  if (current) {
    await db.update(prospectContacts).set(contact).where(eq(prospectContacts.id, current.id));
  } else if (contact.name || contact.email || contact.phone) {
    await db.insert(prospectContacts).values({ prospectId: existing.id, ...contact });
  }

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    action: "prospect.updated",
    entityType: "prospect",
    entityId: publicId,
    metadata: { businessName },
  });

  return { ok: true };
}

/**
 * Take a prospect off the list. Archived, not deleted: the audit trail and any
 * demo built for them still point at the row.
 */
export async function archivePotentialClient(
  ctx: AdminContext,
  db: Database,
  publicId: string,
): Promise<void> {
  const existing = await findActiveProspect(db, publicId);
  const now = new Date();

  await db
    .update(prospects)
    .set({ archivedAt: now, updatedAt: now })
    .where(eq(prospects.id, existing.id));

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    action: "prospect.archived",
    entityType: "prospect",
    entityId: publicId,
    metadata: { businessName: existing.businessName },
  });
}
