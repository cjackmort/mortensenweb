import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Every route authenticates itself.
 *
 * There is no proxy in front of the app. One used to redirect requests without
 * a session cookie to /login, but it only checked that *a* cookie was present —
 * any value passed — and on Netlify it ran as an edge function that
 * cold-started in 1.3–2 s on every visit. The real check was always here, in
 * each page, layout, route handler and server action, where `currentUser()`
 * re-reads the user row and compares `sessionEpoch`.
 *
 * So this test is now the boundary's guard. Every page, layout, route handler
 * and server-action module under `src/app` must call `currentUser()`, or be
 * listed below with the reason it has no session and the check it uses
 * instead. A new route that does neither fails here rather than shipping open.
 *
 * Adding a public route? Add it to SELF_AUTHENTICATING with a reason, and with
 * `checks` naming the call that authenticates it if it has one — a webhook's
 * signature check, a signed link's token check, `CRON_SECRET`.
 */

type Exemption = {
  reason: string;
  /** Text the file must contain: the check that stands in for a session. */
  checks?: string;
};

const SELF_AUTHENTICATING: Record<string, Exemption> = {
  // The router. It reads the token's claims to pick a destination and renders
  // nothing; the destination validates the session.
  "page.tsx": { reason: "routes by role, renders nothing", checks: "sessionHint(" },

  // Reached by someone who cannot sign in, by definition.
  "login/page.tsx": { reason: "sign-in form" },
  "get-started/page.tsx": { reason: "first sign-in with the emailed password" },
  "forgot-password/page.tsx": { reason: "requests a reset link" },
  "reset-password/page.tsx": {
    reason: "the emailed reset token is the authorisation",
    checks: "inspectResetToken(",
  },
  "api/auth/[...nextauth]/route.ts": { reason: "Auth.js's own endpoints", checks: "handlers" },

  // A prospect has no account; the token is the authorisation.
  "preview/[token]/page.tsx": {
    reason: "shared concept link",
    checks: "resolveShareToken(",
  },

  // Webhook senders cannot hold a session; the signature over the raw body is
  // the authentication.
  "api/webhooks/github/route.ts": {
    reason: "GitHub webhook",
    checks: "verifyGithubSignature(",
  },
  "api/webhooks/stripe/route.ts": {
    reason: "Stripe webhook",
    checks: "constructEventAsync(",
  },
  "api/webhooks/stripe-connect/route.ts": {
    reason: "Stripe Connect webhook (the clients' shops)",
    checks: "constructEventAsync(",
  },
  "api/webhooks/netlify-forms/[sitePublicId]/route.ts": {
    reason: "Netlify form webhook",
    checks: "verifyNetlifySignature(",
  },
  "api/webhooks/resend/route.ts": {
    reason: "Resend delivery webhook (bounces, complaints, opens)",
    checks: "verifySvixSignature(",
  },

  // Unsubscribe links in a win-back email, opened by the business's customer,
  // who has no account. The signed token is checked before any query; the
  // POST also rate-limits by hashed IP.
  "unsubscribe/[token]/page.tsx": {
    reason: "unsubscribe page reached from a customer's email",
    checks: "verifyUnsubscribeToken(",
  },
  "api/unsubscribe/[token]/route.ts": {
    reason: "one-click unsubscribe, POSTed by mail providers",
    checks: "verifyUnsubscribeToken(",
  },

  // Fetched by GitHub Actions runners, which have no session. The handler
  // 404s on any token it did not mint.
  "api/attachments/[token]/route.ts": {
    reason: "signed attachment link",
    checks: "verifyAttachmentToken(",
  },
  "api/media/agent/[token]/route.ts": {
    reason: "signed media-library link",
    checks: "verifyMediaAssetToken(",
  },

  // Called by the scheduler and the thumbnail job, which carry CRON_SECRET.
  "api/cron/route.ts": { reason: "scheduler", checks: "CRON_SECRET" },
  "api/thumbnails/route.ts": { reason: "thumbnail job", checks: "CRON_SECRET" },
  "api/thumbnails/[publicId]/route.ts": { reason: "thumbnail job", checks: "CRON_SECRET" },

  // Fetched by mortensenweb.com's build; every figure is already public.
  "api/plans/route.ts": { reason: "public price list" },

  // A campaign's short link, scanned off a door hanger by someone with no
  // account. It resolves only codes the portal minted and 404s on the rest,
  // redirects only to the campaign's own site, and is rate-limited.
  "q/[code]/route.ts": {
    reason: "QR code short link, scanned by the public",
    checks: "findCampaignForRedirect(",
  },
  // Links in a review request, opened by the business's customer, who has no
  // account. Each checks a token signed for its own purpose before any query,
  // and rate-limits by address.
  "review/[token]/route.ts": {
    reason: "tracked review link in a customer's email",
    checks: "verifyReviewToken(",
  },
  "review/[token]/stop/page.tsx": {
    reason: "unsubscribe page reached from a customer's email",
    checks: "verifyReviewToken(",
  },
  "review/[token]/unsubscribe/route.ts": {
    reason: "one-click unsubscribe, POSTed by mail providers",
    checks: "verifyReviewToken(",
  },

  // Read by client websites in their visitors' browsers, where no session can
  // exist. Each returns only what the client chose to publish, and 404s on a
  // site or show it does not list.
  "api/public/sites/[sitePublicId]/events/route.ts": {
    reason: "a site's approved upcoming shows, read by visitors' browsers",
    checks: "listUpcomingEvents(",
  },
  "api/public/sites/[sitePublicId]/events/[eventPublicId]/logo/route.ts": {
    reason: "the logo of a show that is still listed",
    checks: "findListedEventLogo(",
  },
  // A site's shop, read by visitors' browsers: only products the client put
  // on the site, and a checkout that decides every amount itself.
  "api/public/sites/[sitePublicId]/shop/route.ts": {
    reason: "a site's products on sale, read by visitors' browsers",
    checks: "listShopForSite(",
  },
  "api/public/sites/[sitePublicId]/shop/products/[productPublicId]/images/[index]/route.ts": {
    reason: "a photo of a product that is on the site",
    checks: "findProductImage(",
  },
  "api/public/sites/[sitePublicId]/shop/checkout/route.ts": {
    reason: "starts a Stripe Checkout for a visitor; rate-limited, amounts decided server-side",
    checks: "beginShopCheckout(",
  },
  // A booking site's open times and the booking itself, from visitors'
  // browsers. Only sites whose client has booking on; the booking is
  // rate-limited, origin-checked and re-checked in one guarded insert.
  "api/public/sites/[sitePublicId]/availability/route.ts": {
    reason: "a booking site's open times, read by visitors' browsers",
    checks: "openTimesForSite(",
  },
  "api/public/sites/[sitePublicId]/bookings/route.ts": {
    reason: "a visitor books an open time; rate-limited, origin-checked, slot re-checked atomically",
    checks: "requestBooking(",
  },
};

const APP_DIR = join(process.cwd(), "src", "app");

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

/** True for a module whose top-level directive makes every export an action. */
function isServerActionModule(source: string): boolean {
  return /^["']use server["'];?\s*$/m.test(source);
}

/** The files a request can reach: pages, layouts, route handlers, actions. */
function isEntryPoint(path: string, source: string): boolean {
  if (/[\\/](page\.tsx|route\.ts)$/.test(path)) return true;
  // The root layout wraps the sign-in pages too, so it cannot require a user.
  if (/[\\/]layout\.tsx$/.test(path)) return relative(APP_DIR, path) !== "layout.tsx";
  return /\.tsx?$/.test(path) && isServerActionModule(source);
}

/**
 * Comments stripped first, so a file that only *mentions* `currentUser()` —
 * "every page still calls `currentUser()`" — does not count as calling it.
 */
function callsCurrentUser(source: string): boolean {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return /\bcurrentUser\(\)/.test(code);
}

const entryPoints = listFiles(APP_DIR)
  .map((path) => ({ path, source: readFileSync(path, "utf8") }))
  .filter(({ path, source }) => isEntryPoint(path, source))
  .map(({ path, source }) => ({
    key: relative(APP_DIR, path).split(sep).join("/"),
    source,
  }));

describe("the checks this test relies on", () => {
  it("recognises a server-action module but not an inline action", () => {
    expect(isServerActionModule('"use server";\n\nexport async function a() {}')).toBe(true);
    expect(isServerActionModule('async function a() {\n  "use server";\n}')).toBe(false);
  });

  it("does not mistake an import or a comment for a call", () => {
    expect(callsCurrentUser('import { currentUser } from "@/auth";')).toBe(false);
    expect(callsCurrentUser("// every page calls `currentUser()`")).toBe(false);
    expect(callsCurrentUser("/**\n * Gated by `currentUser()`.\n */")).toBe(false);
    expect(callsCurrentUser("const user = await currentUser();")).toBe(true);
  });

  it("finds the routes it is meant to guard", () => {
    const keys = entryPoints.map((e) => e.key);
    expect(keys).toContain("dashboard/page.tsx");
    expect(keys).toContain("dashboard/layout.tsx");
    expect(keys).toContain("admin/layout.tsx");
    expect(keys).toContain("api/media/uploads/route.ts");
    expect(keys).toContain("dashboard/media/actions.ts");
    expect(keys).not.toContain("layout.tsx");
  });
});

describe("every route authenticates itself", () => {
  it("calls currentUser() or is listed as self-authenticating", () => {
    const unguarded = entryPoints
      .filter(({ key, source }) => !callsCurrentUser(source) && !(key in SELF_AUTHENTICATING))
      .map(({ key }) => key);

    expect(
      unguarded,
      "These routes neither call currentUser() nor appear in SELF_AUTHENTICATING. " +
        "Gate them, or list them with the reason they have no session.",
    ).toEqual([]);
  });

  it("finds the stated check in every self-authenticating route", () => {
    for (const [key, { checks }] of Object.entries(SELF_AUTHENTICATING)) {
      const path = join(APP_DIR, key);
      expect(existsSync(path), `${key} is listed but does not exist`).toBe(true);
      if (checks) {
        expect(readFileSync(path, "utf8"), `${key} should contain ${checks}`).toContain(checks);
      }
    }
  });

  it("gates the dashboard and admin layouts before anything renders", () => {
    // The layouts redirect a missing session to /login before streaming
    // begins, which is what the proxy used to do with a cookie check.
    for (const key of ["dashboard/layout.tsx", "admin/layout.tsx"]) {
      const source = entryPoints.find((e) => e.key === key)?.source ?? "";
      expect(source, key).toMatch(/if \(!user\) redirect\("\/login"\)/);
    }
  });
});
