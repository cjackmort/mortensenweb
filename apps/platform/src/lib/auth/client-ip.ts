import { headers } from "next/headers";

/**
 * The caller's IP address, for rate limiting.
 *
 * Every value here arrives in a header, and headers are attacker-controlled
 * unless something in front of the app overwrites them. That distinction is the
 * whole point of the ordering below:
 *
 *  - `cf-connecting-ip` is *set* by Cloudflare on every request and cannot be
 *    forged by the client, so it is trusted first.
 *  - `x-nf-client-connection-ip` is the equivalent from Netlify.
 *  - `x-forwarded-for` is a last resort. Any client can send it, so an attacker
 *    can rotate it freely and evade an IP limit built on it. It is still worth
 *    reading — it raises the cost of casual abuse — but per-account limits are
 *    what actually hold, and those key off the submitted identifier instead.
 *
 * Returns undefined rather than a placeholder when nothing is available: a
 * constant string would collapse every visitor into one rate-limit bucket and
 * lock the whole portal out at the first burst.
 */

/** Header-source form, for callers that already hold a Request. */
export function ipFromHeaders(h: Headers): string | undefined {
  const trusted =
    h.get("cf-connecting-ip") ?? h.get("x-nf-client-connection-ip");
  if (trusted) return trusted.trim();

  const forwarded = h.get("x-forwarded-for");
  if (forwarded) {
    // Left-most entry is the original client; the rest are proxies.
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }

  return h.get("x-real-ip")?.trim() ?? undefined;
}

/** Ambient form, for server components and server actions. */
export async function clientIpAddress(): Promise<string | undefined> {
  try {
    return ipFromHeaders((await headers()) as unknown as Headers);
  } catch {
    // Outside a request scope (a script, a test). No address is the honest
    // answer; the per-account limit still applies.
    return undefined;
  }
}
