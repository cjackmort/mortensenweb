import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import {
  dispatchSubmittedRequests,
  expireStalledJobs,
} from "@/db/repositories/admin/agent-jobs";
import { reverifyPendingPreviews } from "@/db/repositories/admin/webhooks";
import { redoChangesRequested } from "@/db/repositories/admin/revisions";
import { reverifyLiveSites } from "@/db/repositories/admin/launch";
import { advanceShippedChanges } from "@/db/repositories/admin/shipped";
import { expireStaleShares } from "@/db/repositories/admin/maintenance";
import { runDerivativeJobs } from "@/db/repositories/admin/media-jobs";
import { sweepExpiredUploads } from "@/db/repositories/client/media-uploads";
import { reconcileStorageReservations } from "@/db/repositories/client/media-quota";
import { runScheduledReconcile } from "@/db/repositories/admin/stripe-reconcile";
import { runScheduledLeadImport } from "@/db/repositories/admin/leads";
import { runScheduledLedger } from "@/db/repositories/admin/ledger-automation";
import {
  checkGate,
  keepSchedulerAwake,
  recordSchedulerRun,
} from "@/lib/scheduler/gate";
import { constantTimeEqual } from "@/lib/webhooks/signature";

/**
 * The scheduled work.
 *
 * Twelve jobs that have to run whether or not anyone is looking. The first six
 * are the loop's own; jobs 7-9 keep the media library's storage honest,
 * jobs 10-11 are the nets under Stripe's and Netlify Forms' webhooks, and
 * job 12 keeps the books:
 *
 *   1. **Preview re-verification.** Netlify publishes an alias a moment after
 *      the deploy reports success, so a check fired by the webhook can
 *      legitimately miss. Without this, that preview is never shown and the
 *      client waits for something that already exists. This is the job that
 *      makes the half-hour turnaround real.
 *   2. **Agent watchdog.** A workflow that dies leaves a request saying "being
 *      worked on" forever, which tells the client work is happening when
 *      nothing is.
 *   3. **Live-site checks.** Certificates lapse and registrars get tidied up.
 *      The operator should hear it here, not from the client.
 *   4. **Share expiry.** A concept for a business that never replied should not
 *      stay reachable indefinitely.
 *   5. **Dispatching submitted requests.** Auto-dispatch used to run inside
 *      the client's submit action, where opening a GitHub issue shared a
 *      ten-second budget with the photo uploads — together they timed the
 *      function out, and a client whose request had been saved saw a
 *      connection error and typed it again.
 *   6. **Following merged changes to the site.** The merge webhook is the last
 *      thing that touched a shipped request, so it stopped at `merged` and the
 *      client was left reading "Not on your site yet" about a change that was
 *      live. This is the other half of the loop's last mile: confirm the deploy
 *      for the merge commit, then confirm the site actually serves.
 *   7. **Media derivatives.** The safety net for an upload whose nudge did not
 *      land, and the retry path for a resize that failed and backed off.
 *   8. **Abandoned uploads.** A tab closed mid-upload leaves parts and a
 *      placeholder holding quota that nothing else will ever finish.
 *   9. **Storage counters.** Recomputed from what is actually stored, so an
 *      interrupted release does not slowly cost a client room.
 *  10. **Stripe reconciliation.** Self-gated to at most hourly; a net for lost
 *      webhooks rather than something a client is waiting on.
 *  11. **Lead import.** Self-gated to six-hourly; re-reads connected sites'
 *      form submissions so a delivery missed while the portal was down still
 *      reaches the client's inbox.
 *  12. **Ledger.** Self-gated to at most hourly; records Stripe's fee on each
 *      card payment and adds this month's row of every monthly expense.
 *
 * ## Not every call runs them
 *
 * Every job queries Neon, and Neon only sleeps after five idle minutes — so a
 * five-minute tick that always ran kept the database awake around the clock and
 * spent the month's compute by mid-month. `lib/scheduler/gate.ts` decides,
 * without touching the database, whether this call has anything to do:
 *
 *  - a **nudge** (`x-nudge-reason`) always runs, and opens a window in which
 *    the following ticks run too, because it means a client just did something;
 *  - a **forced** call (`x-cron-force: 1`) always runs, for diagnosing by hand;
 *  - anything else runs while an event's window is open, or when the last run
 *    is six hours old, and otherwise answers `skipped` without a query.
 *
 * The gate is checked here rather than in the scheduled function so that every
 * caller passes through it. The GitHub Actions fallback calls this endpoint
 * directly; gating only the Netlify side would leave it waking the database
 * every hour.
 *
 * ## Authentication
 *
 * A shared secret in a header, compared in constant time. This endpoint can
 * merge nothing and send nothing to a client, but it does drive outbound
 * requests and database writes, so leaving it open would hand anyone a way to
 * make the portal hammer Netlify.
 *
 * `CRON_SECRET` unset means the endpoint refuses rather than runs open. A
 * scheduler that is not configured should look broken, because it is.
 */

export const dynamic = "force-dynamic";
// Netlify's function limit is 10s by default and these calls are network-bound.
// The work is chunked (25 previews, 100 sites) so a run fits inside a sensible
// budget; anything not reached is picked up on the next tick.
export const maxDuration = 60;

function authorised(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  // Netlify's own scheduler and a hand-rolled curl differ in which header they
  // can set, so both are accepted.
  const provided =
    request.headers.get("x-cron-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";

  const encoder = new TextEncoder();
  return constantTimeEqual(encoder.encode(provided), encoder.encode(expected));
}

type Admission =
  | { run: true; reason: string; gateFailed: boolean }
  | { run: false; reason: string; awakeUntil: string | null; nextSweepAt: string };

/** Decided before `getDb()`, and without it — that is the whole point. */
async function admit(request: Request): Promise<Admission> {
  const nudge = request.headers.get("x-nudge-reason");
  if (nudge) {
    // Something just made there be work, and its follow-ups (a dispatch, a
    // deploy reaching the live site) land over the next half hour or so.
    const held = await keepSchedulerAwake(`nudge: ${nudge}`);
    return { run: true, reason: "nudged", gateFailed: !held };
  }

  if (request.headers.get("x-cron-force") === "1") {
    return { run: true, reason: "forced", gateFailed: false };
  }

  const decision = await checkGate();
  if (!decision.run) return decision;
  return {
    run: true,
    reason: decision.reason,
    gateFailed: decision.reason === "unreadable",
  };
}

export async function POST(request: Request): Promise<Response> {
  if (!authorised(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const admission = await admit(request);
  if (!admission.run) {
    // The same shape as a run, so every caller that reads `ok` and `degraded`
    // keeps working; `skipped` is the difference.
    return NextResponse.json({
      ok: true,
      degraded: false,
      failedJobs: [],
      skipped: true,
      gate: admission.reason,
      awakeUntil: admission.awakeUntil,
      nextSweepAt: admission.nextSweepAt,
    });
  }

  const db = await getDb();
  const startedAt = new Date();

  // Each job is isolated. One throwing must not stop the others — a Netlify
  // outage breaking preview verification should not also stop the watchdog
  // from telling a client their change failed.
  const results: Record<string, unknown> = {};

  const jobs: [string, () => Promise<unknown>][] = [
    // First: a request sitting undispatched is a client waiting with nothing
    // happening, which is the most visible of these failures.
    ["requestsDispatched", () => dispatchSubmittedRequests(db)],
    // Then the client who looked at a preview and asked for changes — the same
    // wait, one step further along.
    ["changesRedone", () => redoChangesRequested(db)],
    ["previewsVerified", () => reverifyPendingPreviews(db)],
    ["jobsExpired", () => expireStalledJobs(db)],
    ["shippedChanges", () => advanceShippedChanges(db)],
    ["liveSiteProblems", () => reverifyLiveSites(db)],
    ["sharesExpired", () => expireStaleShares(db)],
    // Media derivatives. The upload route nudges this after a completion, so
    // the usual path is seconds; this is the safety net for a nudge that did
    // not land and the retry path for a job that failed and backed off.
    //
    // Bounded at three per tick deliberately. Resizing a 40 MB original is the
    // most expensive thing on this endpoint, and a backlog draining over
    // several ticks is much better than one run being killed halfway through
    // and leaving every asset it touched at `processing`.
    ["mediaDerivatives", () => runDerivativeJobs(db, 3)],
    // Abandoned uploads. A client who closed a tab mid-upload leaves parts and
    // a placeholder holding quota, and nothing else will ever finish them.
    ["mediaUploadsSwept", () => sweepExpiredUploads(db)],
    // Storage counters, recomputed from what is actually stored. The counter is
    // what makes the quota atomic, and this is what makes the counter safe to
    // trust: any interruption between a release and the write that should have
    // followed is corrected here rather than slowly costing a client room.
    ["storageReconciled", () => reconcileStorageReservations(db)],
    // Last, and self-gated to at most hourly — and with the gate above, every
    // six hours while the portal is quiet. It is a net for lost Stripe
    // webhooks, which Stripe itself retries for three days, rather than
    // something a client is waiting on, so it yields the tick's budget to the
    // jobs above and skips most runs on its own.
    ["stripeReconciled", () => runScheduledReconcile(db)],
    // The same kind of net, for contact-form submissions. Self-gated to every
    // six hours; one Netlify call per connected site.
    ["leadsImported", () => runScheduledLeadImport(db)],
    // After the Stripe reconciliation, so a payment it recovered this tick can
    // have its fee recorded in the same one. Self-gated to at most hourly.
    ["ledgerAutomated", () => runScheduledLedger(db)],
  ];

  const failed: string[] = [];

  for (const [name, run] of jobs) {
    try {
      results[name] = await run();
    } catch (error) {
      results[name] = {
        error: error instanceof Error ? error.message : "unknown",
      };
      failed.push(name);
      console.error(`[cron] ${name} failed`, error);
    }
  }

  // Recorded after the jobs rather than before, so a run killed partway is not
  // counted as the sweep and the next tick picks the work back up.
  //
  // A gate that cannot be read or written fails open, which means it quietly
  // goes back to waking the database every tick. Reporting it as a failed job
  // is what makes that visible: the Actions tick goes red instead of the Neon
  // bill being the first sign.
  const recorded = await recordSchedulerRun(startedAt);
  if (admission.gateFailed || !recorded) failed.push("schedulerGate");

  return NextResponse.json({
    // Still 200, and `ok` still means "the endpoint ran" — flipping it would
    // change what every existing caller understands by it. `degraded` is the
    // honest signal beside it: a run where a job threw is not a healthy run,
    // and reporting one as healthy is how a broken job goes unnoticed.
    ok: true,
    degraded: failed.length > 0,
    failedJobs: failed,
    gate: admission.reason,
    ranForMs: Date.now() - startedAt.getTime(),
    ...results,
  });
}

/** A GET is someone poking at the URL. */
export async function GET(): Promise<Response> {
  return new Response(null, { status: 405 });
}
