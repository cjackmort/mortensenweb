import { lookup } from "node:dns/promises";
import { areAllAddressesPublic, inspectUrl, type UrlRefusal } from "./ssrf";

/**
 * Fetching a page we do not control, safely.
 *
 * The guards in `ssrf.ts` decide; this decides *when* to ask them. The answer
 * is: before the first request, and again after every redirect. A public host
 * is allowed to redirect to `169.254.169.254`, so checking only the URL the
 * operator typed protects nothing — which is why redirects are followed by hand
 * here rather than by `fetch`, whose automatic following would do the whole
 * chain before we ever saw it.
 *
 * Nothing about the caller's identity travels: no cookies, no auth header, no
 * referrer. We are reading a public page as an anonymous visitor, and anything
 * more would be either useless or a way to leak our own credentials outward.
 */

export type FetchRefusal =
  | UrlRefusal
  | "dns_failed"
  | "too_many_redirects"
  | "too_large"
  | "timeout"
  | "unreachable"
  | "not_html";

export type PageFetch =
  | {
      ok: true;
      /** Where we ended up. Differs from the request when redirects were followed. */
      finalUrl: string;
      status: number;
      html: string;
    }
  | { ok: false; reason: FetchRefusal; detail: string; status?: number };

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

const DEFAULTS = {
  timeoutMs: 10_000,
  // Enough for any real marketing page; small enough that a hostile server
  // streaming forever cannot exhaust a function's memory.
  maxBytes: 2_000_000,
  maxRedirects: 5,
};

/**
 * Resolve a hostname and refuse it unless every address is public.
 *
 * There is a time-of-check/time-of-use gap here that cannot be closed from
 * userland: DNS could return a public address to this lookup and a private one
 * to the socket a moment later. Closing it properly needs a custom agent that
 * dials a pinned address, which is not available to `fetch` in this runtime.
 * The gap is recorded rather than glossed: it requires an attacker to control
 * the authoritative DNS for a name the operator pasted, and the blast radius is
 * a page body stored as an unverified fact behind an operator's review.
 */
async function hostIsPublic(hostname: string): Promise<boolean> {
  try {
    const results = await lookup(hostname, { all: true, verbatim: true });
    return areAllAddressesPublic(results.map((r) => r.address));
  } catch {
    return false;
  }
}

export async function fetchPublicPage(
  requestUrl: string,
  options: FetchOptions = {},
): Promise<PageFetch> {
  const { timeoutMs, maxBytes, maxRedirects } = { ...DEFAULTS, ...options };

  let current = requestUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const shape = inspectUrl(current);
    if (!shape.ok) {
      return { ok: false, reason: shape.reason ?? "not_a_url", detail: shape.detail ?? "Refused." };
    }

    const { hostname } = new URL(current);
    if (!(await hostIsPublic(hostname))) {
      return {
        ok: false,
        reason: "private_address",
        detail: `${hostname} does not resolve to a public address.`,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(current, {
        method: "GET",
        // Manual, so every hop goes back through the checks above. This is the
        // whole reason this function exists.
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "mortensenweb-portal (+https://mortensenweb.com; site audit)",
          Accept: "text/html,application/xhtml+xml",
        },
        cache: "no-store",
      });
    } catch (error) {
      clearTimeout(timer);
      const aborted = error instanceof Error && error.name === "AbortError";
      return {
        ok: false,
        reason: aborted ? "timeout" : "unreachable",
        detail: aborted ? `No response within ${timeoutMs}ms.` : "Could not reach the page.",
      };
    }

    if (response.status >= 300 && response.status < 400) {
      clearTimeout(timer);
      const location = response.headers.get("location");
      if (!location) {
        return { ok: false, reason: "unreachable", detail: "Redirect without a location.", status: response.status };
      }
      current = new URL(location, current).toString();
      continue;
    }

    // Only HTML is worth reading, and checking before draining the body means a
    // link to a large PDF costs one header exchange rather than a download.
    const contentType = response.headers.get("content-type") ?? "";
    if (response.ok && !contentType.includes("html")) {
      clearTimeout(timer);
      return { ok: false, reason: "not_html", detail: `Content-Type was ${contentType || "absent"}.`, status: response.status };
    }

    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
      clearTimeout(timer);
      return { ok: false, reason: "too_large", detail: `Declared ${declared} bytes.`, status: response.status };
    }

    try {
      const html = await readCapped(response, maxBytes);
      clearTimeout(timer);
      if (html === null) {
        return { ok: false, reason: "too_large", detail: `Body exceeded ${maxBytes} bytes.`, status: response.status };
      }
      return { ok: true, finalUrl: current, status: response.status, html };
    } catch {
      clearTimeout(timer);
      return { ok: false, reason: "unreachable", detail: "Body could not be read.", status: response.status };
    }
  }

  return { ok: false, reason: "too_many_redirects", detail: `More than ${maxRedirects} redirects.` };
}

/**
 * Read a body, stopping at the cap.
 *
 * `content-length` is a claim, not a fact — a server can omit it or lie. This
 * counts what actually arrives, so a response that streams forever is cut off
 * rather than believed.
 */
async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder("utf-8").decode(joined);
}
