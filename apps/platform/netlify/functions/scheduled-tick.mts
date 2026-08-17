/**
 * The scheduler.
 *
 * Netlify's scheduled functions are the cron here. This one does nothing itself
 * — it calls `/api/cron` on the deployed site and reports what came back.
 *
 * ## Why a thin caller rather than doing the work here
 *
 * The work needs the database client, the Drizzle schema, and a dozen
 * repository modules, all of which resolve through the `@/` alias configured
 * for the Next.js build. A Netlify function is bundled separately and does not
 * get that. Reproducing the import graph here would mean maintaining a second
 * build configuration whose only job is to run code that already works in the
 * first one.
 *
 * The trade-off is one extra HTTP hop per tick, which costs a few milliseconds
 * and buys a single implementation of the actual jobs.
 *
 * ## Every five minutes
 *
 * Chosen from the promise the product makes. Changes are meant to reach a
 * client within half an hour, and the main thing standing between a finished
 * build and the client seeing it is preview verification. At five minutes the
 * worst case adds five; at thirty it would eat the entire budget.
 *
 * The jobs are all idempotent — that is a property of each one, not something
 * this file arranges — so an overlapping or repeated run is harmless.
 */

export default async function handler(): Promise<Response> {
  const base = process.env.URL ?? process.env.AUTH_URL;
  const secret = process.env.CRON_SECRET;

  if (!base || !secret) {
    // Loud rather than silent. A scheduler that cannot authenticate should look
    // broken in the function log, not appear to run cleanly while doing nothing.
    console.error(
      "[scheduled-tick] URL or CRON_SECRET is not set; nothing was run.",
    );
    return new Response("Not configured", { status: 500 });
  }

  const response = await fetch(`${base.replace(/\/$/, "")}/api/cron`, {
    method: "POST",
    headers: { "x-cron-secret": secret },
  });

  const body = await response.text();

  if (!response.ok) {
    console.error(`[scheduled-tick] /api/cron responded ${response.status}`, body);
    return new Response(body, { status: response.status });
  }

  console.info("[scheduled-tick]", body);
  return new Response(body, { status: 200 });
}

/**
 * Netlify reads this at build time to register the schedule.
 *
 * Typed inline rather than importing `Config` from `@netlify/functions`, which
 * would mean carrying a dependency solely for one type annotation on a
 * two-field object. Netlify parses the exported value; it does not need ours to
 * have come from their package.
 */
export const config: { schedule: string } = {
  schedule: "*/5 * * * *",
};
