/**
 * The session cookie's name.
 *
 * ## The problem this solves
 *
 * Cookies ignore the port. `localhost:3000` and `localhost:3100` share one
 * cookie jar, so two development servers running different branches hand each
 * other sessions signed with different `AUTH_SECRET`s. The receiving server
 * cannot decrypt what it is given and answers `JWTSessionError: no matching
 * decryption secret` — which reads like broken authentication rather than like
 * two servers talking past each other, and cost real time to diagnose.
 *
 * ## Why a name and not a hostname
 *
 * Separate hostnames (`analytics.localtest.me`, and so on) would also work and
 * need no code, but they need every developer to have the hosts entry or to
 * trust a wildcard DNS service, and `AUTH_URL` has to match or the sign-in
 * redirect breaks. A distinct cookie name is one variable, works on a fresh
 * clone with no host configuration, and fails visibly if it is wrong.
 *
 * ## Production is deliberately not configurable
 *
 * `DEV_COOKIE_SUFFIX` is read **only** outside production. Letting an
 * environment variable rename the production session cookie would be a way to
 * silently sever every existing session, and — worse — a way to make the
 * secure `__Secure-` prefix disappear, since that prefix is what stops a cookie
 * set over plain HTTP from being accepted. Production always gets the standard
 * names, prefix included, whatever the environment says.
 */

const BASE = "authjs.session-token";

/**
 * A suffix is accepted only in development, and only if it looks like a cookie
 * name. Anything else is ignored rather than corrupting the header.
 */
function devSuffix(): string {
  if (process.env.NODE_ENV === "production") return "";
  const raw = process.env.DEV_COOKIE_SUFFIX ?? "";
  return /^[A-Za-z0-9_-]{1,32}$/.test(raw) ? `.${raw}` : "";
}

/** Insecure (HTTP) name. Development only in practice. */
export function sessionCookieName(): string {
  return `${BASE}${devSuffix()}`;
}

/**
 * Secure name, used when the site is served over HTTPS.
 *
 * The `__Secure-` prefix is a browser-enforced rule: a cookie carrying it is
 * rejected unless it is set over HTTPS with the Secure attribute. Keeping it
 * intact in production is the point of the guard above.
 */
export function secureSessionCookieName(): string {
  return `__Secure-${BASE}${devSuffix()}`;
}

/**
 * Every name a session might arrive under, for the proxy's presence check.
 *
 * Both the plain and secure forms, because the proxy only asks "is there a
 * session cookie at all" before deciding whether to redirect to sign-in — it
 * is a convenience, not the authorization boundary.
 */
export function sessionCookieNames(): string[] {
  return [sessionCookieName(), secureSessionCookieName()];
}
