import { NextResponse, type NextRequest } from "next/server";

/**
 * Proxy (Next 16's name for what was `middleware.ts` — same file, same
 * matcher, renamed by the framework's own codemod) is a redirect convenience,
 * NOT an authorization boundary.
 *
 * It only checks whether a session cookie is present, so an unauthenticated
 * visitor lands on /login instead of a flash of empty dashboard. It
 * deliberately does not import the auth config or the database: the proxy
 * runs before the Node.js server context is available, and pulling the
 * database driver in here would break the build and tempt us into treating
 * this file as the security check.
 *
 * The real checks live in each page and route handler, where `currentUser()`
 * re-reads the user row and compares `sessionEpoch`, and where the repository
 * layer enforces tenant scope. A forged or stale cookie gets past the proxy
 * and is then rejected by those. That ordering is intentional.
 */

const SESSION_COOKIES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
];

const PUBLIC_PATHS = [
  "/login",
  "/get-started",
  // Both halves of the reset flow are reached by someone who cannot sign in,
  // so both must be public or the flow redirects to the screen it exists to
  // rescue them from.
  "/forgot-password",
  "/reset-password",
  "/api/auth",
  // Shared concept links. A prospect has no account by definition, so
  // redirecting them to a sign-in page would make the link useless. The route
  // authenticates the token itself and 404s on anything it does not recognise.
  "/preview",
  // Webhook receivers. GitHub and Square cannot hold a session; the HMAC
  // signature over the raw body is the authentication, verified in the handler.
  // A redirect here would silently swallow every delivery and eventually get
  // the integration disabled by the sender.
  "/api/webhooks",
  // Signed attachment links. The reader is a GitHub Actions runner fetching a
  // client's uploaded photo; it has no session and cannot be given one. The
  // signed token in the path is the authorisation, and the handler 404s on
  // anything it did not mint. Without this entry the runner would follow a
  // redirect to /login and quietly receive an HTML page instead of an image.
  "/api/attachments",
  // The scheduler. It calls this from a Netlify scheduled function, which
  // carries no session and cannot be given one — the endpoint authenticates
  // itself with CRON_SECRET, compared in constant time, and refuses outright
  // when that is unset.
  //
  // Without this entry the call is redirected to /login and answered with a
  // 307. Nothing errors: the scheduler records a response, the endpoint is
  // never reached, and every job it exists to run silently does not. Preview
  // verification is one of them, so a client is never shown a preview that was
  // built, deployed and serving correctly the whole time.
  "/api/cron",
  // The auth screens' background photo, served from public/. The matcher
  // below only excludes _next/static and _next/image, not arbitrary files
  // under public/ — so without this entry, every visitor without a session
  // cookie (i.e. everyone the login page exists for) has this request
  // redirected to /login instead of served, and the background silently
  // never loads for the one audience it's for.
  "/auth-backdrop.webp",
  "/auth-backdrop-sm.webp",
  // The installable-app manifest and its icons. A phone fetches these without
  // a session when the client adds the portal to their home screen; redirected
  // to /login they would install a generic bookmark instead of the app.
  "/manifest.webmanifest",
  "/icon.svg",
  "/maskable.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Exact match or a path segment beneath it. A bare `startsWith` would also
  // match `/login-something`, quietly widening the public surface every time
  // someone adds a route with a shared prefix.
  const isPublic = PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  if (isPublic) {
    return NextResponse.next();
  }

  const hasSessionCookie = SESSION_COOKIES.some((name) =>
    request.cookies.has(name),
  );

  if (!hasSessionCookie) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Everything except Next internals and static assets. Authenticated
     * surfaces additionally carry no-store headers from next.config.ts.
     */
    "/((?!_next/static|_next/image|favicon.ico|robots.txt).*)",
  ],
};
