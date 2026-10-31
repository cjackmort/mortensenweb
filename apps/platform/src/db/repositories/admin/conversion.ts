import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog } from "@/db/schema";
import { siteHomeUrl } from "@/components/site-preview";
import { GithubApiError, GithubConfigError } from "@/lib/github/app";
import { NetlifyApiError, NetlifyConfigError } from "@/lib/netlify/api";
import {
  loadClient,
  loadProspect,
  loadSite,
  loadSiteJson,
  type ConversionProspect,
  type SiteJsonLoad,
} from "./conversion-state";
import {
  CONVERSION_STEPS,
  STEP_DEFINITIONS,
  type ConversionStepId,
  type ConvertOptions,
  type Prerequisite,
  type RunState,
  type StepStatus,
} from "./conversion-steps";
import type { AdminContext } from "../context";

/**
 * Converting a potential client into a client (D6).
 *
 * One function behind both doors: `POST /api/operator/prospects/:id/convert`
 * and the "Convert to client" button on the potential client's page.
 *
 * ## Idempotent by step
 *
 * Each run records its report in the audit log (`prospect.conversion_run`),
 * and the next run reads the last one: a step that ended `ok` is reported
 * again without being repeated, and everything else is tried afresh. So
 * re-running after fixing a failure redoes only what failed, and running it
 * twice by accident creates nothing twice. `rerun` names steps to repeat
 * anyway — after a token is replaced, say.
 *
 * The client itself is guarded harder than that, because it is the one step
 * whose duplicate would be a real mess: one client per organization is a
 * unique index, so even two runs racing past every other check end with one.
 *
 * ## One at a time
 *
 * A run takes a lease — a `prospect.conversion_started` row — and a second run
 * arriving while it is younger than `LEASE_MS` and unfinished is turned away.
 * There are no transactions on the HTTP driver to lock with, so this narrows
 * the race rather than closing it; the unique index is what holds if it is
 * lost.
 */

const LEASE_MS = 2 * 60_000;
const STARTED = "prospect.conversion_started";
const FINISHED = "prospect.conversion_run";

/** Same-instance double submissions, which the lease row is too slow to see. */
const running = new Set<string>();

export interface StepReport {
  id: ConversionStepId;
  status: StepStatus;
  detail: string;
  /** Finished by an earlier run and not repeated. */
  carried?: true;
}

export interface ConversionReport {
  prospectId: string;
  businessName: string;
  clientId: string | null;
  sitePublicId: string | null;
  repository: string | null;
  siteUrl: string | null;
  /** True when no step failed. `manual` steps are the client's or a merge, not faults. */
  complete: boolean;
  via: ConvertOptions["via"];
  ranAt: string;
  steps: StepReport[];
}

export type ConvertOutcome =
  | { ok: true; report: ConversionReport }
  | { ok: false; reason: "in_progress" };

const MISSING: Record<Prerequisite, string> = {
  client: "Needs the client record, which was not created.",
  site: "No concept site was built for this potential client. Build one, or connect a repository on the client's page.",
  repo: "The site has no repository the portal can write to.",
};

/** Steps after which the client or site may have changed under the run. */
const REFRESH_AFTER = new Set<ConversionStepId>(["client", "site", "site_kinds"]);

export async function convertProspect(
  ctx: AdminContext,
  db: Database,
  prospectPublicId: string,
  options: ConvertOptions,
): Promise<ConvertOutcome> {
  const prospect = await loadProspect(db, prospectPublicId);
  if (running.has(prospect.id) || (await leaseHeld(db, prospect.publicId))) {
    return { ok: false, reason: "in_progress" };
  }

  running.add(prospect.id);
  try {
    await db.insert(auditLog).values({
      actorUserId: ctx.userId,
      action: STARTED,
      entityType: "prospect",
      entityId: prospect.publicId,
      metadata: { via: options.via },
    });

    const previous = await latestReport(db, prospect.publicId);
    const { report, organizationId } = await runSteps(ctx, db, prospect, options, previous);

    await db.insert(auditLog).values({
      actorUserId: ctx.userId,
      organizationId,
      action: FINISHED,
      entityType: "prospect",
      entityId: prospect.publicId,
      metadata: { report },
    });

    return { ok: true, report };
  } finally {
    running.delete(prospect.id);
  }
}

async function runSteps(
  ctx: AdminContext,
  db: Database,
  prospect: ConversionProspect,
  options: ConvertOptions,
  previous: ConversionReport | null,
): Promise<{ report: ConversionReport; organizationId: string | null }> {
  const rerun = new Set(options.rerun ?? []);
  const prior = new Map((previous?.steps ?? []).map((step) => [step.id, step]));

  let siteJsonFor: { siteId: string; load: Promise<SiteJsonLoad> } | null = null;
  const state: RunState = {
    ctx,
    db,
    prospect,
    options,
    client: null,
    site: null,
    // Read at most once per run, and only by a step that needs it.
    siteJson: () => {
      const siteId = state.site?.siteId ?? "";
      if (siteJsonFor?.siteId !== siteId) {
        siteJsonFor = { siteId, load: loadSiteJson(state.site) };
      }
      return siteJsonFor.load;
    },
  };

  const refresh = async () => {
    const client = await loadClient(db, prospect.id);
    state.client = client;
    state.site = await loadSite(db, prospect.id, client?.siteId ?? null);
  };
  await refresh();

  const steps: StepReport[] = [];
  for (const id of CONVERSION_STEPS) {
    const definition = STEP_DEFINITIONS[id];
    const missing = definition.needs.find((need) =>
      need === "client" ? !state.client : need === "site" ? !state.site : !state.site?.repo,
    );
    if (missing) {
      steps.push({ id, status: "skipped", detail: MISSING[missing] });
      continue;
    }

    // A finished client step is only believed while the client still exists:
    // every step after it depends on that record, not on the report.
    const before = prior.get(id);
    const stillTrue = id !== "client" || state.client !== null;
    if (before?.status === "ok" && stillTrue && !rerun.has(id)) {
      steps.push({ id, status: "ok", detail: before.detail, carried: true });
      continue;
    }

    try {
      steps.push({ id, ...(await definition.run(state as never)) });
      if (REFRESH_AFTER.has(id)) await refresh();
    } catch (error) {
      console.error("[conversion] step failed", { step: id, prospect: prospect.publicId, error });
      steps.push({ id, status: "failed", detail: describeError(error) });
    }
  }

  return {
    organizationId: state.client?.organizationId ?? null,
    report: {
      prospectId: prospect.publicId,
      businessName: prospect.businessName,
      clientId: state.client?.clientPublicId ?? null,
      sitePublicId: state.site?.sitePublicId ?? null,
      repository: state.site?.repo?.repository ?? null,
      siteUrl: state.site ? siteHomeUrl(state.site) : null,
      complete: steps.every((step) => step.status !== "failed"),
      via: options.via,
      ranAt: new Date().toISOString(),
      steps,
    },
  };
}

/**
 * What a provider said, when it said something an operator can act on.
 * Anything else is described generically; the log has the rest.
 */
function describeError(error: unknown): string {
  if (
    error instanceof GithubApiError ||
    error instanceof GithubConfigError ||
    error instanceof NetlifyApiError ||
    error instanceof NetlifyConfigError
  ) {
    return error.message;
  }
  return "Unexpected error. The portal's log has the details.";
}

async function leaseHeld(db: Database, prospectPublicId: string): Promise<boolean> {
  const rows = await db
    .select({ action: auditLog.action, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, "prospect"),
        eq(auditLog.entityId, prospectPublicId),
        inArray(auditLog.action, [STARTED, FINISHED]),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1);

  const latest = rows[0];
  return (
    latest?.action === STARTED && Date.now() - latest.createdAt.getTime() < LEASE_MS
  );
}

function isReport(value: unknown): value is ConversionReport {
  const report = value as ConversionReport | undefined;
  return Boolean(report && typeof report.prospectId === "string" && Array.isArray(report.steps));
}

async function latestReport(db: Database, prospectPublicId: string): Promise<ConversionReport | null> {
  const [row] = await db
    .select({ metadata: auditLog.metadata })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, FINISHED),
        eq(auditLog.entityType, "prospect"),
        eq(auditLog.entityId, prospectPublicId),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1);

  const report = (row?.metadata as { report?: unknown } | null)?.report;
  return isReport(report) ? report : null;
}

export type ConversionState =
  | { state: "not_started"; report: null }
  | { state: "running"; report: ConversionReport | null }
  | { state: "finished"; report: ConversionReport };

/** The latest report for a potential client, for `GET` and the admin page. */
export async function readConversion(db: Database, prospectPublicId: string): Promise<ConversionState> {
  const prospect = await loadProspect(db, prospectPublicId);
  const [report, inProgress] = await Promise.all([
    latestReport(db, prospect.publicId),
    leaseHeld(db, prospect.publicId),
  ]);

  if (inProgress) return { state: "running", report };
  return report ? { state: "finished", report } : { state: "not_started", report: null };
}
