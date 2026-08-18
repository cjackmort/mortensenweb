import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { expireStalledJobs } from "@/db/repositories/admin/agent-jobs";
import { reverifyPendingPreviews } from "@/db/repositories/admin/webhooks";
import { reverifyLiveSites } from "@/db/repositories/admin/launch";
import { advanceShippedChanges } from "@/db/repositories/admin/shipped";
import { expireStaleShares } from "@/db/repositories/admin/maintenance";
import { constantTimeEqual } from "@/lib/webhooks/signature";

/**
 * The scheduled work.
 *
 * Five jobs that have to run whether or not anyone is looking:
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
 *   5. **Following merged changes to the site.** The merge webhook is the last
 *      thing that touched a shipped request, so it stopped at `merged` and the
 *      client was left reading "Not on your site yet" about a change that was
 *      live. This is the other half of the loop's last mile: confirm the deploy
 *      for the merge commit, then confirm the site actually serves.
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

export async function POST(request: Request): Promise<Response> {
  if (!authorised(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const db = await getDb();
  const started = Date.now();

  // Each job is isolated. One throwing must not stop the others — a Netlify
  // outage breaking preview verification should not also stop the watchdog
  // from telling a client their change failed.
  const results: Record<string, unknown> = {};

  const jobs: [string, () => Promise<unknown>][] = [
    ["previewsVerified", () => reverifyPendingPreviews(db)],
    ["jobsExpired", () => expireStalledJobs(db)],
    ["shippedChanges", () => advanceShippedChanges(db)],
    ["liveSiteProblems", () => reverifyLiveSites(db)],
    ["sharesExpired", () => expireStaleShares(db)],
  ];

  for (const [name, run] of jobs) {
    try {
      results[name] = await run();
    } catch (error) {
      results[name] = {
        error: error instanceof Error ? error.message : "unknown",
      };
      console.error(`[cron] ${name} failed`, error);
    }
  }

  return NextResponse.json({
    ok: true,
    ranForMs: Date.now() - started,
    ...results,
  });
}

/** A GET is someone poking at the URL. */
export async function GET(): Promise<Response> {
  return new Response(null, { status: 405 });
}
