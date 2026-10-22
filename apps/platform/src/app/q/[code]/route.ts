import { getDb } from "@/db/client";
import { findCampaignForRedirect, recordScan } from "@/db/repositories/admin/campaign-redirect";
import { ipFromHeaders } from "@/lib/auth/client-ip";
import { normaliseCode } from "@/lib/campaigns/links";
import { coarsePlace, createRateLimiter, deviceClass, visitorHash } from "@/lib/campaigns/scan-facts";

/**
 * A campaign's short link: `/q/<code>`, printed under every QR code.
 *
 * Public by necessity — the person scanning a door hanger has no account —
 * and listed in `tests/route-auth.test.ts` for that reason. What stands in
 * for a session: it only resolves codes the portal minted (an unknown or
 * malformed code is a 404 with nothing behind it), it only ever redirects to
 * the campaign's own site, and it is rate-limited per address.
 *
 * ## Printed codes must never break
 *
 * A paused campaign still redirects; pausing only stops the counting. A
 * scan that fails to record still redirects; the count is ours, the
 * customer on the doorstep is the client's. Only a code that resolves to no
 * site address at all stops here, because there is nowhere to send them.
 *
 * 302, never 301: a permanent redirect is cached by the browser, so a
 * second scan would skip the count and a changed destination would never be
 * seen by anyone who had scanned before.
 */

export const dynamic = "force-dynamic";

/** Per address, per function instance. No person scans thirty codes a minute. */
const limiter = createRateLimiter({ limit: 30, windowMs: 60_000 });

const NO_STORE = {
  "Cache-Control": "no-store, max-age=0",
  "X-Robots-Tag": "noindex",
};

function page(status: number, title: string, body: string, extra: Record<string, string> = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.4rem">${title}</h1><p>${body}</p></body></html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE, ...extra },
  });
}

const UNKNOWN = () =>
  page(404, "This link doesn't go anywhere", "Check the address against the one printed under the code and try again.");

async function handle(request: Request, rawCode: string, shouldCount: boolean): Promise<Response> {
  const code = normaliseCode(rawCode);
  if (!code) return UNKNOWN();

  const ip = ipFromHeaders(request.headers);
  if (ip && !limiter.hit(ip)) {
    return page(429, "Too many tries", "Please wait a minute and scan the code again.", { "Retry-After": "60" });
  }

  let db;
  let target;
  try {
    db = await getDb();
    target = await findCampaignForRedirect(db, code);
  } catch (error) {
    console.error("[campaigns] short link lookup failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return page(503, "This link is having trouble", "Please try again in a minute.", { "Retry-After": "30" });
  }
  if (!target) return UNKNOWN();
  if (!target.url) {
    return page(404, "This link isn't set up yet", "The business's website isn't live at its address yet.");
  }

  const device = deviceClass(request.headers);
  if (shouldCount && !target.paused && device !== "bot") {
    try {
      const now = new Date();
      await recordScan(db, target, {
        device,
        ...coarsePlace(request.headers),
        visitorHash: await visitorHash(process.env.AUTH_SECRET, ip, request.headers.get("user-agent"), now),
      }, now);
    } catch (error) {
      console.error("[campaigns] scan not recorded", {
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  return new Response(null, { status: 302, headers: { Location: target.url, ...NO_STORE } });
}

export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  return handle(request, (await params).code, true);
}

/** Link checkers and some scanner apps ask first; answering is not a scan. */
export async function HEAD(request: Request, { params }: { params: Promise<{ code: string }> }) {
  return handle(request, (await params).code, false);
}
