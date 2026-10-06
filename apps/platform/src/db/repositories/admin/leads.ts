import { and, eq, gte, isNotNull, isNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, leads, sites } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { parseSubmission, siteHookSecret, type ParsedLead } from "@/lib/growth/netlify-forms";
import {
  connectFormsWebhook,
  isNetlifyConfigured,
  listFormSubmissions,
  NetlifyApiError,
} from "@/lib/netlify/api";
import type { AdminContext } from "../context";

/**
 * Leads, from the system's side: what the webhook receiver, the backfill and
 * the operator's "connect" button do. The client's reads and status changes
 * are in `client/leads.ts`, behind a `TenantContext`.
 *
 * The receiver has no session — Netlify cannot hold one — so recording a lead
 * takes no context at all. What scopes it is the site, which the receiver
 * resolved from the signed URL; the lead's organization is copied from that
 * site row and never from anything in the payload.
 */

export interface FormsSite {
  id: string;
  publicId: string;
  organizationId: string;
  netlifySiteId: string | null;
}

export async function findSiteForForms(
  db: Database,
  sitePublicId: string,
): Promise<FormsSite | null> {
  const rows = await db
    .select({
      id: sites.id,
      publicId: sites.publicId,
      organizationId: sites.organizationId,
      netlifySiteId: sites.netlifySiteId,
    })
    .from(sites)
    .where(and(eq(sites.publicId, sitePublicId), isNull(sites.archivedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Store one submission. Returns whether it was new.
 *
 * Idempotent on Netlify's submission id: the webhook can redeliver, and the
 * backfill re-reads what the webhook already delivered. Either way the second
 * write is a no-op and — because only a *new* row is announced — the client is
 * emailed once.
 */
export async function recordLead(
  db: Database,
  site: FormsSite,
  lead: ParsedLead,
  {
    now = new Date(),
    asHistory = false,
  }: {
    now?: Date;
    /**
     * Imported rather than delivered: stored already read, because the
     * client has seen it before (in their email, or on Netlify) and an inbox
     * that opens on a wall of bold "new" rows they already dealt with is
     * noise.
     */
    asHistory?: boolean;
  } = {},
): Promise<{ created: false } | { created: true; leadId: string }> {
  const inserted = await db
    .insert(leads)
    .values({
      publicId: newPublicId(),
      organizationId: site.organizationId,
      siteId: site.id,
      provider: "netlify",
      providerSubmissionId: lead.submissionId,
      formName: lead.formName,
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      message: lead.message,
      fields: lead.fields,
      pageUrl: lead.pageUrl,
      receivedAt: lead.receivedAt ?? now,
      readAt: asHistory ? now : null,
    })
    .onConflictDoNothing({
      target: [leads.provider, leads.providerSubmissionId],
    })
    .returning({ id: leads.id });

  const row = inserted[0];
  return row ? { created: true, leadId: row.id } : { created: false };
}

export type ImportOutcome =
  | { ok: true; imported: number; alreadyHad: number }
  | { ok: false; message: string };

/**
 * Pull what Netlify holds for a site into the inbox, without announcing any of it.
 *
 * Used when a site is first connected (its history) and from the six-hourly
 * sweep (anything the webhook missed while the portal was down). Neither is
 * news to the client in the way a fresh enquiry is, and connecting a site
 * with a year of submissions must not send a year of emails.
 */
export async function importSiteSubmissions(
  db: Database,
  site: FormsSite,
  { maxPages }: { maxPages?: number } = {},
): Promise<ImportOutcome> {
  if (!site.netlifySiteId) {
    return { ok: false, message: "This site has no Netlify site yet." };
  }
  if (!isNetlifyConfigured()) {
    return { ok: false, message: "NETLIFY_AUTH_TOKEN is not set." };
  }

  let payloads;
  try {
    payloads = await listFormSubmissions(site.netlifySiteId, { maxPages });
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Netlify could not be reached.",
    };
  }

  let imported = 0;
  let alreadyHad = 0;
  for (const payload of payloads) {
    const parsed = parseSubmission(payload);
    if (!parsed.ok) continue;
    const result = await recordLead(db, site, parsed.lead, { asHistory: true });
    if (result.created) imported += 1;
    else alreadyHad += 1;
  }

  return { ok: true, imported, alreadyHad };
}

/** Where a site's hook delivers. The site's id in the path is what the receiver scopes by. */
export function formsWebhookUrl(sitePublicId: string): string | null {
  const base = process.env.AUTH_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? "";
  if (!base.startsWith("https://")) return null;
  return `${base.replace(/\/$/, "")}/api/webhooks/netlify-forms/${sitePublicId}`;
}

export type ConnectOutcome =
  | { ok: true; imported: number }
  | { ok: false; message: string };

/**
 * Connect a site's contact forms to the leads inbox: register the hook, then
 * import what is already there.
 *
 * In that order so nothing falls between them. A submission arriving after
 * the hook exists is delivered by it; one that arrived before is in the
 * import; one arriving during both is in both, and the upsert keeps one.
 */
export async function connectSiteForms(
  _ctx: AdminContext,
  db: Database,
  sitePublicId: string,
): Promise<ConnectOutcome> {
  const site = await findSiteForForms(db, sitePublicId);
  if (!site) return { ok: false, message: "That site no longer exists." };
  if (!site.netlifySiteId) {
    return { ok: false, message: "Set up hosting for this site first." };
  }

  const master = process.env.NETLIFY_FORMS_WEBHOOK_SECRET;
  if (!master) {
    return { ok: false, message: "NETLIFY_FORMS_WEBHOOK_SECRET is not set." };
  }
  if (!isNetlifyConfigured()) {
    return { ok: false, message: "NETLIFY_AUTH_TOKEN is not set." };
  }
  const url = formsWebhookUrl(site.publicId);
  if (!url) {
    // Netlify cannot deliver to localhost, and a plain-http URL would send
    // customers' names and messages across the internet unencrypted.
    return { ok: false, message: "AUTH_URL must be the portal's https:// address." };
  }

  let hookId: string;
  try {
    ({ hookId } = await connectFormsWebhook({
      siteId: site.netlifySiteId,
      url,
      signatureSecret: await siteHookSecret(master, site.publicId),
    }));
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof NetlifyApiError || error instanceof Error
          ? error.message
          : "Netlify could not be reached.",
    };
  }

  await db
    .update(sites)
    .set({ formsHookId: hookId, formsConnectedAt: new Date(), updatedAt: new Date() })
    .where(eq(sites.id, site.id));

  const imported = await importSiteSubmissions(db, site);
  // The hook is the part that matters. A failed import leaves an inbox that
  // fills from now on, and the next sweep retries the history.
  return { ok: true, imported: imported.ok ? imported.imported : 0 };
}

/** Sites whose forms are connected — the sweep's list to repair. */
export async function listConnectedFormSites(db: Database): Promise<FormsSite[]> {
  return db
    .select({
      id: sites.id,
      publicId: sites.publicId,
      organizationId: sites.organizationId,
      netlifySiteId: sites.netlifySiteId,
    })
    .from(sites)
    .where(and(isNotNull(sites.formsConnectedAt), isNull(sites.archivedAt)));
}

const IMPORT_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type ScheduledImportResult =
  | { ran: false; reason: "not_configured" | "too_soon" | "no_sites" }
  | { ran: true; sites: number; imported: number; failed: number };

/**
 * The net under the webhook: re-read every connected site's submissions, at
 * most every six hours.
 *
 * Self-gated in the audit log, like the Stripe reconcile, because the
 * scheduler runs every five minutes while anything is happening and this is
 * one Netlify call per site — nobody is waiting on it, and a lead the webhook
 * delivered is already in the inbox. Only the newest page is read: anything a
 * missed delivery left behind is recent by definition.
 */
export async function runScheduledLeadImport(
  db: Database,
  { now = new Date() }: { now?: Date } = {},
): Promise<ScheduledImportResult> {
  if (!isNetlifyConfigured()) return { ran: false, reason: "not_configured" };

  const recent = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "leads.imported"),
        gte(auditLog.createdAt, new Date(now.getTime() - IMPORT_INTERVAL_MS)),
      ),
    )
    .limit(1);
  if (recent.length > 0) return { ran: false, reason: "too_soon" };

  const connected = await listConnectedFormSites(db);
  if (connected.length === 0) return { ran: false, reason: "no_sites" };

  let imported = 0;
  let failed = 0;
  for (const site of connected) {
    const outcome = await importSiteSubmissions(db, site, { maxPages: 1 });
    if (outcome.ok) imported += outcome.imported;
    else failed += 1;
  }

  await db.insert(auditLog).values({
    action: "leads.imported",
    entityType: "leads",
    entityId: null,
    metadata: { sites: connected.length, imported, failed },
  });

  return { ran: true, sites: connected.length, imported, failed };
}
