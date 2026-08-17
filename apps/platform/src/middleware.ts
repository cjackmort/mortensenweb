import { NextResponse, type NextRequest } from "next/server";

/**
 * Middleware is a redirect convenience, NOT an authorization boundary.
 *
 * It only checks whether a session cookie is present, so an unauthenticated
 * visitor lands on /login instead of a flash of empty dashboard. It
 * deliberately does not import the auth config or the database: middleware
 * runs before the Node.js server context is available, and pulling the
 * database driver in here would break the build and tempt us into treating
 * this file as the security check.
 *
 * The real checks live in each page and route handler, where `currentUser()`
 * re-reads the user row and compares `sessionEpoch`, and where the repository
 * layer enforces tenant scope. A forged or stale cookie gets past middleware
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
];

export function middleware(request: NextRequest) {
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
