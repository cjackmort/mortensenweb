import type { NextConfig } from "next";

/**
 * Content Security Policy.
 *
 * `script-src` carries 'unsafe-inline' because Next.js injects inline bootstrap
 * and hydration scripts. Removing it means generating a per-request nonce in
 * middleware and threading it through — a real upgrade, and a real risk of
 * shipping a blank page, so it is deliberately not bundled into a security fix.
 * A browser that supports nonces ignores 'unsafe-inline' when a nonce is
 * present, so that migration is additive when it happens.
 *
 * The directives carrying the most weight here are the ones that cost nothing:
 * `form-action 'self'` stops injected script from retargeting the sign-in form
 * at another origin, `base-uri 'self'` stops an injected <base> from rewriting
 * every relative URL on the page, and `object-src 'none'` removes plugin
 * embedding outright.
 */
const CSP = [
  "default-src 'self'",
  // 'unsafe-eval' is needed by the dev-mode React refresh runtime, not in prod.
  process.env.NODE_ENV === "production"
    ? "script-src 'self' 'unsafe-inline'"
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  // Preview screenshots are served from the client's own preview deploy
  // (`<preview>/__preview/home-390.png`, written by the deploy workflow).
  // Those are on netlify.app and, later, on the client's domain — so `https:`
  // rather than a list that would need editing per client.
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  // The admin overview frames each client's live home page as a thumbnail
  // (components/site-preview.tsx). Those pages live on the clients' own
  // domains, so they cannot be enumerated here; `https:` is the narrowest
  // source that still admits them. Only pages the portal itself embeds are
  // affected — nothing in this directive lets another site frame the portal,
  // which `frame-ancestors 'none'` below still forbids.
  process.env.NODE_ENV === "production"
    ? "frame-src https:"
    : "frame-src https: http://localhost:*",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

/**
 * Every route that renders per-tenant data or handles a credential.
 *
 * This list is the cache boundary, so a new authenticated route that is not
 * added here is a route a proxy may cache and serve to the wrong client. Note
 * `dashboard` rather than `client`: the client surface lives at /dashboard, and
 * naming a route group that does not exist protects nothing.
 */
const SENSITIVE_ROUTES =
  "admin|dashboard|change-password|reset-password|forgot-password|get-started|login|api";

const NO_STORE = [
  { key: "Cache-Control", value: "no-store, must-revalidate" },
  { key: "Pragma", value: "no-cache" },
];

const nextConfig: NextConfig = {
  experimental: {
    /**
     * Uploads arrive through a server action, and the default cap is 1 MB.
     *
     * The form invites six photos at up to 10 MB. A single photo from a phone
     * is 3–5 MB, so the request exceeded the limit before reaching any of our
     * code: the action died, the browser reported the page as unresponsive,
     * and everything the client had typed went with it. They then retyped it
     * and hit the same wall.
     *
     * 6 MB rather than the 60 MB the form implies, because the client now
     * downscales images before sending — see `request-form.tsx`. A 4000px
     * phone photo becomes roughly 300 KB, so six of them fit comfortably, and
     * this is a backstop rather than the working limit. It is also as much as
     * a serverless request body can carry without a different upload path
     * entirely.
     */
    serverActions: { bodySizeLimit: "6mb" },
  },

  reactStrictMode: true,

  // The portal serves per-tenant data. A CDN or proxy caching an authenticated
  // HTML response would serve one client's dashboard to another, so every
  // response carries no-store. Static assets are content-hashed and handled
  // separately by the framework.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Content-Security-Policy", value: CSP },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
        ],
      },
      {
        // Authenticated surfaces: never cached anywhere.
        source: `/(${SENSITIVE_ROUTES})/:path*`,
        headers: NO_STORE,
      },
      {
        // `:path*` matches zero segments in most cases, but the bare route is
        // the one that actually renders the dashboard — spell it out rather
        // than depend on that.
        source: `/:route(${SENSITIVE_ROUTES})`,
        headers: NO_STORE,
      },
      {
        // The router entry point. It redirects, but a cached redirect to
        // /admin served to a client is still the wrong answer.
        source: "/",
        headers: NO_STORE,
      },
    ];
  },

  // PGlite is a development-only WASM database. Marking it external keeps its
  // bundle out of the server build; it is additionally behind a runtime dynamic
  // import, so a deployed function never loads it.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
