import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Two kinds of isolation that only bite in development, and one guarantee that
 * must survive both.
 *
 *  1. The session cookie. Cookies ignore the port, so two dev servers on
 *     localhost share a jar and hand each other sessions encrypted under
 *     different secrets — which surfaces as `no matching decryption secret` and
 *     reads like broken authentication.
 *  2. The database. The server, the migration runner and the tests must all
 *     resolve the same file, or migrations are applied to something nobody is
 *     reading.
 *
 * The guarantee: nothing added for either may weaken production authentication.
 */

const ORIGINAL_ENV = { ...process.env };

/**
 * `NODE_ENV` is typed read-only, and these tests exist precisely to check
 * behaviour on both sides of it. One narrow helper rather than a cast at every
 * assignment.
 */
function setNodeEnv(value: string): void {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

async function cookieModule() {
  // Re-imported per test because the names are read from the environment at
  // call time and the module caches nothing.
  return import("@/lib/auth/cookie-name");
}

describe("development cookie names", () => {
  it("separates two dev servers when a suffix is set", async () => {
    setNodeEnv("development");
    process.env.DEV_COOKIE_SUFFIX = "analytics";
    const { sessionCookieName } = await cookieModule();

    expect(sessionCookieName()).toBe("authjs.session-token.analytics");
  });

  it("falls back to the standard name with no suffix", async () => {
    setNodeEnv("development");
    delete process.env.DEV_COOKIE_SUFFIX;
    const { sessionCookieName } = await cookieModule();

    expect(sessionCookieName()).toBe("authjs.session-token");
  });

  it("ignores a suffix that is not a safe cookie-name fragment", async () => {
    setNodeEnv("development");
    const { sessionCookieName } = await cookieModule();

    for (const bad of ["has space", "semi;colon", "equals=sign", "", "a".repeat(40)]) {
      process.env.DEV_COOKIE_SUFFIX = bad;
      // A malformed suffix would corrupt the Set-Cookie header rather than
      // merely being ugly, so it is dropped instead of sanitised.
      expect(sessionCookieName(), bad).toBe("authjs.session-token");
    }
  });
});

describe("production authentication is not weakened", () => {
  it("ignores the suffix entirely in production", async () => {
    setNodeEnv("production");
    process.env.DEV_COOKIE_SUFFIX = "attacker";
    const { sessionCookieName, secureSessionCookieName } = await cookieModule();

    // Renaming the production cookie would silently sever every live session.
    expect(sessionCookieName()).toBe("authjs.session-token");
    expect(secureSessionCookieName()).toBe("__Secure-authjs.session-token");
  });

  it("keeps the __Secure- prefix, which the browser enforces", async () => {
    setNodeEnv("production");
    const { secureSessionCookieName } = await cookieModule();

    // A cookie carrying this prefix is rejected unless it was set over HTTPS
    // with Secure. Losing it would let a cookie set over plain HTTP be
    // accepted, so no environment variable may remove it.
    expect(secureSessionCookieName().startsWith("__Secure-")).toBe(true);
  });

  it("uses the secure name and the secure flag in production", () => {
    // Read as source rather than imported: importing `auth.ts` pulls in the
    // database and the provider chain, which this assertion does not need.
    const source = readFileSync("src/auth.ts", "utf8");

    expect(source).toContain('process.env.NODE_ENV === "production"');
    expect(source).toContain("secureSessionCookieName()");
    expect(source).toContain('secure: process.env.NODE_ENV === "production"');
    expect(source).toContain("httpOnly: true");
  });

  it("keeps the proxy's names in step with the auth config", () => {
    // Hardcoding them in two places is how a developer ends up redirected to
    // /login forever while holding a perfectly valid session.
    const proxy = readFileSync("src/proxy.ts", "utf8");
    expect(proxy).toContain("sessionCookieNames()");
    expect(proxy).not.toContain('"authjs.session-token"');
  });
});

describe("the development database is resolved the same way everywhere", () => {
  it("uses one rule for the server, the migration runner and the tests", () => {
    // `PGLITE_DATA_DIR` is honoured by both, defaulting to ./.pglite. What
    // matters is that they agree: `npm run db:migrate` does NOT load
    // .env.local, so setting the variable there alone would point the server
    // at one database and the migrations at another, and the schema would
    // appear to be missing.
    const client = readFileSync("src/db/client.ts", "utf8");
    const migrate = readFileSync("scripts/migrate.ts", "utf8");

    expect(client).toContain("PGLITE_DATA_DIR");
    expect(migrate).toContain("PGLITE_DATA_DIR");
    expect(client).toContain('"./.pglite"');
    expect(migrate).toContain('"./.pglite"');
  });

  it("selects PGlite only when DATABASE_URL is not a postgres URL", async () => {
    const { isPgliteMode } = await import("@/db/client");

    process.env.DATABASE_URL = "";
    expect(isPgliteMode()).toBe(true);

    delete process.env.DATABASE_URL;
    expect(isPgliteMode()).toBe(true);

    // A real connection string must never silently fall back to a local file:
    // that is how a migration "succeeds" against nothing.
    process.env.DATABASE_URL = "postgres://user:pw@host/db";
    expect(isPgliteMode()).toBe(false);
    process.env.DATABASE_URL = "postgresql://user:pw@host/db";
    expect(isPgliteMode()).toBe(false);
  });
});
