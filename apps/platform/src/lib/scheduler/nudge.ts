import { after } from "next/server";

/**
 * Ask the scheduler to run now rather than at the next five-minute tick.
 *
 * Dispatch and the post-approval checks live on the cron endpoint for a good
 * reason (they share a ten-second action budget with photo uploads, and used
 * to time it out). The cost was that a request sat idle for up to five
 * minutes — two and a half on average — before anything happened, and the
 * client watched "Received" do nothing.
 *
 * This is the same endpoint the scheduler calls, called one extra time, right
 * after the action that made there be something to do. It runs in `after()`,
 * once the response has gone back to the client, so the submit itself gets no
 * slower and a slow or failed nudge cannot break it. The scheduled tick stays
 * as the safety net; every job on that endpoint is idempotent, so running it
 * twice is harmless.
 *
 * Silent when `CRON_SECRET` or the site URL is unset — the cron endpoint would
 * refuse the call anyway, and development has no scheduler to nudge.
 */
export function nudgeScheduler(reason: string): void {
  const base = process.env.AUTH_URL ?? process.env.NEXT_PUBLIC_SITE_URL;
  const secret = process.env.CRON_SECRET;
  if (!base || !secret) return;

  after(async () => {
    try {
      const response = await fetch(`${base.replace(/\/$/, "")}/api/cron`, {
        method: "POST",
        headers: { "x-cron-secret": secret, "x-nudge-reason": reason },
        // The cron endpoint can take a while when it has real work; the
        // nudge does not need the answer, only to have started it.
        signal: AbortSignal.timeout(25_000),
      });
      if (!response.ok) {
        console.warn(`[nudge] /api/cron responded ${response.status} (${reason})`);
      }
    } catch (error) {
      console.warn("[nudge] could not reach the scheduler", {
        reason,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  });
}
