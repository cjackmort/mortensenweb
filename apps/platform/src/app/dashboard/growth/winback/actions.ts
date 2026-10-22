"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { requireGrowthFeature } from "@/db/repositories/client/growth";
import {
  approveCampaign,
  cancelCampaign,
  createDraft,
  deleteDraft,
  saveDraft,
  type SaveResult,
} from "@/db/repositories/client/winback-campaigns";
import { importContacts, removeContact, syncWonLeads } from "@/db/repositories/client/winback-contacts";
import {
  guessMapping,
  mapRows,
  MAPPING_FIELDS,
  MAX_IMPORT_BYTES,
  parseCsv,
  type ColumnMapping,
} from "@/lib/winback/csv";
import { nudgeScheduler } from "@/lib/scheduler/nudge";

/**
 * Win-back mutations. Each re-derives the tenant from the session — a server
 * action is a public POST endpoint — and re-checks the feature, because the
 * page being gated does not stop a POST to its actions. Only the client
 * themselves: an operator viewing as them is refused by `assertMutable` in
 * the repositories, and a session without a client role never gets that far.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

const BASE = "/dashboard/growth/winback";
const NOT_IN_PLAN: ActionResult = { ok: false, message: "Your plan does not include win-back emails. See Growth to add it." };

async function session() {
  const user = await currentUser();
  if (!user?.organizationId || user.role !== "client") return null;
  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  if (!(await requireGrowthFeature(db, ctx, "winback"))) return "locked" as const;
  return { ctx, db };
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function textOf(formData: FormData) {
  return {
    name: field(formData, "name"),
    subject: field(formData, "subject"),
    body: field(formData, "body"),
    offer: field(formData, "offer"),
    offerExpiresOn: field(formData, "offerExpiresOn"),
  };
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export async function createDraftAction(formData: FormData): Promise<void> {
  const s = await session();
  if (!s) redirect("/login");
  if (s === "locked") redirect("/dashboard/growth?locked=winback#winback");
  let publicId: string;
  try {
    publicId = await createDraft(s.db, s.ctx, field(formData, "occasion"));
  } catch (error) {
    if (error instanceof NotFoundError) redirect(BASE);
    throw error;
  }
  redirect(`${BASE}/${publicId}`);
}

export async function saveDraftAction(_previous: SaveResult | null, formData: FormData): Promise<SaveResult> {
  const s = await session();
  if (!s) return { ok: false, message: "Please sign in again." };
  if (s === "locked") return NOT_IN_PLAN;
  const publicId = field(formData, "campaign");
  try {
    const result = await saveDraft(s.db, s.ctx, publicId, textOf(formData));
    if (result.ok) revalidatePath(`${BASE}/${publicId}`);
    return result;
  } catch (error) {
    if (error instanceof NotFoundError) return { ok: false, message: "That draft no longer exists." };
    throw error;
  }
}

export async function approveCampaignAction(_previous: SaveResult | null, formData: FormData): Promise<SaveResult> {
  const s = await session();
  if (!s) return { ok: false, message: "Please sign in again." };
  if (s === "locked") return NOT_IN_PLAN;
  const publicId = field(formData, "campaign");
  let result;
  try {
    result = await approveCampaign(s.db, s.ctx, publicId, { ...textOf(formData), scheduleDay: field(formData, "scheduleDay") });
  } catch (error) {
    if (error instanceof NotFoundError) return { ok: false, message: "That draft no longer exists." };
    throw error;
  }
  if (!result.ok) return result;
  // Sending is the scheduler's job; ask it to start now rather than at its
  // next tick. A scheduled one waits for its day.
  if (result.sendsNow) nudgeScheduler("winback approved");
  revalidatePath(BASE);
  redirect(`${BASE}/${publicId}?approved=1`);
}

export async function cancelCampaignAction(_previous: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const s = await session();
  if (!s) return { ok: false, message: "Please sign in again." };
  if (s === "locked") return NOT_IN_PLAN;
  const publicId = field(formData, "campaign");
  try {
    const result = await cancelCampaign(s.db, s.ctx, publicId);
    if (result.ok) {
      revalidatePath(BASE);
      revalidatePath(`${BASE}/${publicId}`);
    }
    return result;
  } catch (error) {
    if (error instanceof NotFoundError) return { ok: false, message: "That email no longer exists." };
    throw error;
  }
}

export async function deleteDraftAction(formData: FormData): Promise<void> {
  const s = await session();
  if (!s) redirect("/login");
  if (s === "locked") redirect("/dashboard/growth?locked=winback#winback");
  try {
    await deleteDraft(s.db, s.ctx, field(formData, "campaign"));
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
  }
  revalidatePath(BASE);
  redirect(BASE);
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export async function syncWonLeadsAction(_previous: ActionResult | null): Promise<ActionResult> {
  const s = await session();
  if (!s) return { ok: false, message: "Please sign in again." };
  if (s === "locked") return NOT_IN_PLAN;
  const { added } = await syncWonLeads(s.db, s.ctx);
  revalidatePath(`${BASE}/customers`);
  return {
    ok: true,
    message: added === 0 ? "Every enquiry you've marked won is already on your list." : `Added ${added} from your leads inbox.`,
  };
}

export async function removeContactAction(formData: FormData): Promise<void> {
  const s = await session();
  if (!s) redirect("/login");
  if (s === "locked") redirect("/dashboard/growth?locked=winback#winback");
  try {
    await removeContact(s.db, s.ctx, field(formData, "contact"));
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
  }
  revalidatePath(`${BASE}/customers`);
}

export type ImportState =
  | { step: "idle" }
  | { step: "error"; message: string; csv?: string; fileName?: string; headers?: string[]; mapping?: ColumnMapping; rows?: number }
  | {
      step: "map";
      csv: string;
      fileName: string;
      headers: string[];
      mapping: ColumnMapping;
      sample: string[][];
      rows: number;
    }
  | { step: "done"; message: string };

function mappingFrom(formData: FormData, headers: string[]): ColumnMapping {
  const mapping = {} as ColumnMapping;
  for (const { key } of MAPPING_FIELDS) {
    const raw = field(formData, `map_${key}`);
    const index = raw === "" ? null : Number(raw);
    mapping[key] = index !== null && Number.isInteger(index) && index >= 0 && index < headers.length ? index : null;
  }
  return mapping;
}

/** Two steps, one action: read the file and propose a mapping, then import with the mapping chosen. */
export async function importCustomersAction(_previous: ImportState, formData: FormData): Promise<ImportState> {
  const s = await session();
  if (!s) return { step: "error", message: "Please sign in again." };
  if (s === "locked") return { step: "error", message: NOT_IN_PLAN.message };

  if (field(formData, "step") !== "import") {
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { step: "error", message: "Choose a CSV file to import." };
    if (file.size > MAX_IMPORT_BYTES) return { step: "error", message: "That file is over 1 MB. Split it and import it in parts." };
    const csv = await file.text();
    try {
      const parsed = parseCsv(csv);
      if (parsed.headers.length === 0 || parsed.rows.length === 0) {
        return { step: "error", message: "That file has no rows under its heading row." };
      }
      return {
        step: "map",
        csv,
        fileName: file.name,
        headers: parsed.headers,
        mapping: guessMapping(parsed.headers),
        sample: parsed.rows.slice(0, 3),
        rows: parsed.rows.length,
      };
    } catch (error) {
      return { step: "error", message: error instanceof Error ? error.message : "That file couldn't be read as CSV." };
    }
  }

  const csv = field(formData, "csv");
  const fileName = field(formData, "fileName");
  if (csv.length > MAX_IMPORT_BYTES * 2) return { step: "error", message: "That file is too large." };
  let parsed;
  try {
    parsed = parseCsv(csv);
  } catch (error) {
    return { step: "error", message: error instanceof Error ? error.message : "That file couldn't be read as CSV." };
  }
  const mapping = mappingFrom(formData, parsed.headers);
  const back = { csv, fileName, headers: parsed.headers, mapping, rows: parsed.rows.length };
  if (field(formData, "confirm") !== "yes") {
    return { step: "error", message: "Tick the box to confirm these are your customers.", ...back };
  }
  if (mapping.email === null) return { step: "error", message: "Choose which column holds the email address.", ...back };

  const { contacts, skipped } = mapRows(parsed, mapping);
  const { added, alreadyHad: already } = await importContacts(s.db, s.ctx, { fileName, contacts });
  revalidatePath(`${BASE}/customers`);

  const parts = [`Added ${added} ${added === 1 ? "customer" : "customers"}.`];
  if (already > 0) parts.push(`${already} were already on your list.`);
  const noEmail = skipped.filter((r) => r.reason === "no_email").length;
  if (noEmail > 0) parts.push(`${noEmail} ${noEmail === 1 ? "row had" : "rows had"} no usable email address.`);
  const dupes = skipped.length - noEmail;
  if (dupes > 0) parts.push(`${dupes} ${dupes === 1 ? "row was a repeat" : "rows were repeats"} in the file.`);
  return { step: "done", message: parts.join(" ") };
}
