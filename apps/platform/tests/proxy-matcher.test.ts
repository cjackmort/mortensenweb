import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config, proxy, PUBLIC_PATHS } from "@/proxy";

/**
 * Which requests invoke the proxy at all.
 *
 * On Netlify the proxy runs as an edge function that cold-starts in over a
 * second, so the matcher leaves out the public paths. That is only safe if
 * leaving them out changes nothing — if every path the matcher skips is one
 * the proxy would have waved through anyway. A matcher that skipped an
 * authenticated page would quietly drop its redirect to sign-in.
 */

const PORTAL = "https://portal.mortensenweb.com";

function invokesProxy(path: string): boolean {
  return unstable_doesMiddlewareMatch({ config, url: path });
}

function proxyRedirects(path: string): boolean {
  const response = proxy(new NextRequest(`${PORTAL}${path}`));
  return response.headers.get("location") !== null;
}

const AUTHENTICATED = [
  "/",
  "/dashboard",
  "/dashboard/requests",
  "/dashboard/media",
  "/admin",
  "/admin/clients/abc123",
  "/change-password",
  "/api/media/uploads",
  "/api/media/assets/abc/thumb",
  "/api/sites/abc/thumbnail",
];

// Lookalikes of public paths. Each must still reach the proxy, or a prefix
// match has widened the public surface.
const LOOKALIKES = [
  "/login-something",
  "/loginx",
  "/api/plans-admin",
  "/api/cronjobs",
  "/previews",
  "/api/media/agentx",
  "/icon.svgx",
];

describe("the proxy's matcher", () => {
  it("skips only paths the proxy would pass through unchanged", () => {
    const samples = [
      ...PUBLIC_PATHS,
      ...PUBLIC_PATHS.map((p) => `${p}/nested`),
      ...AUTHENTICATED,
      ...LOOKALIKES,
      "/wp-login.php",
    ];

    for (const path of samples) {
      if (invokesProxy(path)) continue;
      expect(proxyRedirects(path), `${path} is skipped but would redirect`).toBe(false);
    }
  });
});
