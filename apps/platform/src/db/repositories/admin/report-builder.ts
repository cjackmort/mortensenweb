import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { GrowthFeatureKey } from "@mortensenweb/plans";
import type { Database } from "@/db/client";
import {
  analyticsConnections,
  changeRequests,
  clientAddOns,
  clients,
  leads,
  monthlyReports,
  organizations,
  servicePlans,
  sites,
  subscriptions,
} from "@/db/schema";
import { growthAccess, hasFeature, type FeatureAccess } from "@/lib/growth/access";
import { isManagementPaused } from "@/lib/reports/eligibility";
import { monthAnalytics, type MonthAnalytics } from "@/lib/reports/analytics";
import { REPORT_EXTENSIONS, type ReportExtension } from "@/lib/reports/extensions";
import { previousPeriod, reportWindow, type ReportWindow } from "@/lib/reports/period";
import {
  missingSection,
  REPORT_VERSION,
  reportDataSchema,
  type ExtraSection,
  type MonthlyReportData,
} from "@/lib/reports/types";

/**
 * Building a monthly report: everything the portal knows about one client's
 * month, gathered into the snapshot `monthly_reports.data` holds.
 *
 * System-side, like the lead receiver: the scheduler has no session, so these
 * take an organization id the caller resolved itself — from the client table,
 * never from a request. Every query below filters on it.
 */

/** A client the report is about: who they are, and what their plan includes. */
export interface ReportSubject {
  organizationId: string;
  clientId: string;
  businessName: string;
  planKey: string | null;
  planName: string | null;
  comped: boolean;
  /** `YYYY-MM-DD`; null when there is no active subscription. */
  subscriptionStartedOn: string | null;
  createdAt: Date;
  isDemo: boolean;
  /** Our work on them is paused (see `isManagementPaused`): no scheduled report. */
  managementPaused: boolean;
  access: FeatureAccess[];
}

const compPlan = alias(servicePlans, "comp_plan");

/** Report subjects, optionally narrowed to one organization. */
export async function loadReportSubjects(
  db: Database,
  { organizationId }: { organizationId?: string } = {},
): Promise<ReportSubject[]> {
  const rows = await db
    .select({
      organizationId: clients.organizationId,
      clientId: clients.id,
      businessName: organizations.name,
      planKey: servicePlans.key,
      planName: servicePlans.name,
      compKey: compPlan.key,
      compName: compPlan.name,
      compPlanId: clients.compPlanId,
      startedOn: subscriptions.startedOn,
      createdAt: clients.createdAt,
      isDemo: clients.isDemo,
      managementState: clients.managementState,
      managementPausedAt: clients.managementPausedAt,
    })
    .from(clients)
    .innerJoin(organizations, eq(organizations.id, clients.organizationId))
    .leftJoin(subscriptions, and(eq(subscriptions.clientId, clients.id), eq(subscriptions.status, "active")))
    .leftJoin(servicePlans, eq(servicePlans.id, subscriptions.planId))
    .leftJoin(compPlan, eq(compPlan.id, clients.compPlanId))
    .where(
      and(
        isNull(clients.archivedAt),
        organizationId ? eq(clients.organizationId, organizationId) : undefined,
      ),
    );

  if (rows.length === 0) return [];

  const addOns = await db
    .select({ clientId: clientAddOns.clientId, featureKey: clientAddOns.featureKey })
    .from(clientAddOns)
    .where(and(inArray(clientAddOns.clientId, rows.map((r) => r.clientId)), isNull(clientAddOns.endedAt)));

  return rows.map((row) => {
    const comped = row.compPlanId !== null;
    const planKey = row.compKey ?? row.planKey;
    return {
      organizationId: row.organizationId,
      clientId: row.clientId,
      businessName: row.businessName,
      planKey,
      planName: row.compName ?? row.planName,
      comped,
      subscriptionStartedOn: row.startedOn,
      createdAt: row.createdAt,
      isDemo: row.isDemo,
      managementPaused: isManagementPaused(row),
      access: growthAccess({
        planKey,
        comped,
        addOns: addOns
          .filter((a) => a.clientId === row.clientId)
          .map((a) => a.featureKey as GrowthFeatureKey),
      }),
    };
  });
}

interface ReportSite {
  name: string;
  domain: string | null;
  live: boolean;
  liveVerifiedAt: Date | null;
  umamiWebsiteId: string | null;
}

/**
 * The site the report is about: the same one the dashboard's figures come
 * from (first by name), so the report and the dashboard cannot disagree.
 */
async function primarySite(db: Database, organizationId: string): Promise<ReportSite | null> {
  const [row] = await db
    .select({
      name: sites.name,
      domain: sites.primaryDomain,
      status: sites.status,
      liveVerifiedAt: sites.liveVerifiedAt,
      umamiWebsiteId: analyticsConnections.umamiWebsiteId,
    })
    .from(sites)
    .leftJoin(analyticsConnections, eq(analyticsConnections.siteId, sites.id))
    .where(and(eq(sites.organizationId, organizationId), isNull(sites.archivedAt)))
    .orderBy(asc(sites.name))
    .limit(1);
  if (!row) return null;
  return {
    name: row.name,
    domain: row.domain,
    live: row.status === "live",
    liveVerifiedAt: row.liveVerifiedAt,
    umamiWebsiteId: row.umamiWebsiteId,
  };
}

async function formsConnected(db: Database, organizationId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.organizationId, organizationId), isNull(sites.archivedAt), isNotNull(sites.formsConnectedAt)))
    .limit(1);
  return Boolean(row);
}

async function enquiriesSection(
  db: Database,
  organizationId: string,
  window: ReportWindow,
  previous: ReportWindow,
): Promise<NonNullable<MonthlyReportData["enquiries"]>> {
  const inMonth = sql`${leads.receivedAt} >= ${window.startAt.toISOString()} and ${leads.receivedAt} < ${window.endAt.toISOString()}`;
  const [counts] = await db
    .select({
      received: sql<number>`(count(*) filter (where ${inMonth}))::int`,
      previous: sql<number>`(count(*) filter (where ${leads.receivedAt} < ${previous.endAt.toISOString()}))::int`,
      won: sql<number>`(count(*) filter (where ${inMonth} and ${leads.status} = 'won'))::int`,
      awaitingReply: sql<number>`(count(*) filter (where ${inMonth} and ${leads.status} = 'new'))::int`,
    })
    .from(leads)
    .where(
      and(
        eq(leads.organizationId, organizationId),
        // A deleted lead is a tombstone the client removed, usually as spam.
        isNull(leads.deletedAt),
        gte(leads.receivedAt, previous.startAt),
        lt(leads.receivedAt, window.endAt),
      ),
    );

  const received = Number(counts?.received ?? 0);
  // With no form delivering to the inbox, a zero means "not counted", not
  // "nobody wrote". Leads already in the inbox are still real, so they win.
  if (received === 0 && !(await formsConnected(db, organizationId))) {
    return missingSection("forms_not_connected");
  }
  return {
    state: "ok",
    received,
    previous: Number(counts?.previous ?? 0),
    won: Number(counts?.won ?? 0),
    awaitingReply: Number(counts?.awaitingReply ?? 0),
  };
}

async function completedChanges(db: Database, organizationId: string, window: ReportWindow) {
  // `verified` is the one status that means "live on the site and checked";
  // `closed` is a cancellation. `closed_at` is set when it was verified.
  const rows = await db
    .select({ title: changeRequests.title, closedAt: changeRequests.closedAt })
    .from(changeRequests)
    .where(
      and(
        eq(changeRequests.organizationId, organizationId),
        eq(changeRequests.status, "verified"),
        gte(changeRequests.closedAt, window.startAt),
        lt(changeRequests.closedAt, window.endAt),
      ),
    )
    .orderBy(asc(changeRequests.closedAt));
  return rows.map((row) => ({ title: row.title, completedAt: row.closedAt!.toISOString() }));
}

/** Not confirmed online for this long at build time is worth saying. */
const STALE_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

function healthSection(site: ReportSite | null, now: Date): MonthlyReportData["health"] {
  if (!site) return missingSection("no_site");
  const confirmed = site.liveVerifiedAt;
  return {
    state: "ok",
    live: site.live,
    lastConfirmedAt: site.live && confirmed ? confirmed.toISOString() : null,
    stale: site.live && (!confirmed || now.getTime() - confirmed.getTime() > STALE_AFTER_MS),
  };
}

async function extraSections(
  db: Database,
  subject: ReportSubject,
  window: ReportWindow,
  now: Date,
  extensions: ReportExtension[],
): Promise<ExtraSection[]> {
  const sections: ExtraSection[] = [];
  for (const extension of extensions) {
    // Leave out any Growth feature the client does not have — not even an
    // empty section, which would read as "you have this and it did nothing".
    if (!hasFeature(subject.access, extension.feature)) continue;
    try {
      const built = await extension.build({ db, organizationId: subject.organizationId, window, now });
      if (built) sections.push({ ...built, key: extension.key, title: extension.title });
    } catch (error) {
      console.error(`[reports] extension ${extension.key} failed`, {
        organizationId: subject.organizationId,
        message: error instanceof Error ? error.message : "unknown",
      });
      sections.push({
        key: extension.key,
        title: extension.title,
        state: "missing",
        headline: null,
        rows: [],
        note: "This part of the report couldn't be produced.",
      });
    }
  }
  return sections;
}

export interface BuildOptions {
  now?: Date;
  extensions?: ReportExtension[];
}

/** One client's month, as a report. Reads only; saving is the caller's step. */
export async function buildReportData(
  db: Database,
  subject: ReportSubject,
  period: string,
  { now = new Date(), extensions = REPORT_EXTENSIONS }: BuildOptions = {},
): Promise<MonthlyReportData> {
  const window = reportWindow(period);
  const previous = reportWindow(previousPeriod(period));
  const site = await primarySite(db, subject.organizationId);

  const analytics: MonthAnalytics = site
    ? await monthAnalytics(site.umamiWebsiteId, window, previous)
    : { visitors: missingSection("no_site"), contact: missingSection("no_site") };

  const [enquiries, changes, extras] = await Promise.all([
    hasFeature(subject.access, "leads")
      ? enquiriesSection(db, subject.organizationId, window, previous)
      : Promise.resolve(null),
    completedChanges(db, subject.organizationId, window),
    extraSections(db, subject, window, now, extensions),
  ]);

  // Parsed on the way in as well as out: a builder bug fails here, loudly,
  // rather than being stored and failing every time the report is opened.
  return reportDataSchema.parse({
    version: REPORT_VERSION,
    period,
    label: window.label,
    previousMonthName: previous.monthName,
    startAt: window.startAt.toISOString(),
    endAt: window.endAt.toISOString(),
    businessName: subject.businessName,
    site: site ? { name: site.name, domain: site.domain } : null,
    planName: subject.planName,
    visitors: analytics.visitors,
    contact: analytics.contact,
    enquiries,
    changes: { items: changes },
    health: healthSection(site, now),
    extras,
    builtAt: now.toISOString(),
  } satisfies MonthlyReportData);
}

/**
 * Store a report. Without `replace`, only the first write for a month wins
 * and says so — which is how two overlapping runs end up sending one email.
 */
export async function saveReport(
  db: Database,
  organizationId: string,
  data: MonthlyReportData,
  { replace = false, now = new Date() }: { replace?: boolean; now?: Date } = {},
): Promise<{ created: boolean }> {
  // `createdAt` is set here, not left to the database, so a replace can tell
  // a fresh insert from an update by comparing it with `now`.
  const values = { organizationId, period: data.period, data, builtAt: now, createdAt: now, updatedAt: now };

  if (replace) {
    const [row] = await db
      .insert(monthlyReports)
      .values(values)
      .onConflictDoUpdate({
        target: [monthlyReports.organizationId, monthlyReports.period],
        set: { data, builtAt: now, updatedAt: now },
      })
      .returning({ createdAt: monthlyReports.createdAt });
    return { created: row ? row.createdAt.getTime() === now.getTime() : false };
  }

  const inserted = await db
    .insert(monthlyReports)
    .values(values)
    .onConflictDoNothing({ target: [monthlyReports.organizationId, monthlyReports.period] })
    .returning({ id: monthlyReports.id });
  return { created: inserted.length > 0 };
}
