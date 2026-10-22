import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAUTH_COOKIE, sealOAuthState, verifyOAuthState } from "@/lib/google-business/oauth-state";

/**
 * Connecting Google: the start route and the callback.
 *
 * The callback is reachable by anyone who can make the operator's browser
 * follow a link, so what matters is what it refuses: a code whose state does
 * not match the cookie, an expired round trip, a different signed-in user,
 * and anyone who is not an active admin. None of those may reach the code
 * exchange.
 */

const user = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
const connect = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock("@/auth", () => ({ currentUser: async () => user.current }));
vi.mock("@/db/client", () => ({ getDb: async () => ({}) }));
vi.mock("@/db/repositories/admin/google-connection", () => ({
  completeGoogleConnect: (...args: unknown[]) => connect.fn(...args),
}));

const ADMIN = {
  userId: "admin-1",
  organizationId: null,
  role: "admin",
  status: "active",
  sessionEpoch: 0,
  email: "operator@example.test",
  name: "Scott",
  mustChangePassword: false,
};

beforeEach(() => {
  vi.stubEnv("GOOGLE_CLIENT_ID", "client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
  vi.stubEnv("GOOGLE_TOKEN_KEY", Buffer.alloc(32, 1).toString("base64"));
  vi.stubEnv("AUTH_URL", "https://portal.example");
  vi.stubEnv("AUTH_SECRET", "a-secret-long-enough-for-hmac-signing");
  user.current = ADMIN;
  connect.fn.mockReset();
  connect.fn.mockResolvedValue({ ok: true, email: "agency@example.test", status: { state: "connected" } });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function start() {
  const { GET } = await import("@/app/api/google/oauth/start/route");
  return GET(new Request("https://portal.example/api/google/oauth/start"));
}

async function callback(query: string, cookie?: string) {
  const { GET } = await import("@/app/api/google/oauth/callback/route");
  return GET(
    new Request(`https://portal.example/api/google/oauth/callback?${query}`, {
      headers: cookie ? { cookie: `other=1; ${OAUTH_COOKIE}=${cookie}` } : {},
    }),
  );
}

describe("starting the connection", () => {
  it("sends an admin to Google with a signed, httpOnly state cookie", async () => {
    const response = await start();
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.host).toBe("accounts.google.com");
    expect(location.searchParams.get("redirect_uri")).toBe("https://portal.example/api/google/oauth/callback");

    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toContain(`${OAUTH_COOKIE}=`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=lax/i);
    expect(setCookie).toMatch(/Path=\/api\/google\/oauth/);
  });

  it("is not there for anyone but an active admin", async () => {
    user.current = { ...ADMIN, role: "client", organizationId: "org" };
    expect((await start()).status).toBe(404);
    user.current = null;
    expect(new URL((await start()).headers.get("location")!).pathname).toBe("/login");
  });

  it("says so rather than redirecting to Google when Google is not set up", async () => {
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    expect((await start()).headers.get("location")).toBe("https://portal.example/admin/google?connect=not_configured");
  });
});

describe("the callback", () => {
  async function cookieFor(overrides: Partial<{ state: string; userId: string; expiresAt: number }> = {}) {
    return sealOAuthState({
      state: "the-state",
      codeVerifier: "the-verifier",
      userId: ADMIN.userId,
      expiresAt: Date.now() + 60_000,
      ...overrides,
    });
  }

  it("exchanges the code with the verifier from the cookie", async () => {
    const response = await callback("code=abc&state=the-state", await cookieFor());
    expect(response.headers.get("location")).toBe("https://portal.example/admin/google?connect=connected");
    expect(connect.fn).toHaveBeenCalledWith(expect.anything(), expect.anything(), { code: "abc", codeVerifier: "the-verifier" });
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
  });

  it("reports a connection without API access as its own outcome", async () => {
    connect.fn.mockResolvedValue({ ok: true, email: "agency@example.test", status: { state: "no_access" } });
    const response = await callback("code=abc&state=the-state", await cookieFor());
    expect(response.headers.get("location")).toBe("https://portal.example/admin/google?connect=no_access");
  });

  it("refuses a wrong state, an expired trip, another user, a forged cookie, and no cookie", async () => {
    const cases = [
      await callback("code=abc&state=other-state", await cookieFor()),
      await callback("code=abc&state=the-state", await cookieFor({ expiresAt: Date.now() - 1 })),
      await callback("code=abc&state=the-state", await cookieFor({ userId: "someone-else" })),
      await callback("code=abc&state=the-state", `${(await cookieFor()).split(".")[0]}.forged`),
      await callback("code=abc&state=the-state"),
    ];
    for (const response of cases) {
      expect(response.headers.get("location")).toBe("https://portal.example/admin/google?connect=expired");
    }
    expect(connect.fn).not.toHaveBeenCalled();
  });

  it("does nothing for a non-admin, even with a valid cookie", async () => {
    const cookie = await cookieFor();
    user.current = { ...ADMIN, role: "client", organizationId: "org" };
    expect((await callback("code=abc&state=the-state", cookie)).status).toBe(404);
    expect(connect.fn).not.toHaveBeenCalled();
  });

  it("says when the operator cancelled at Google", async () => {
    const response = await callback("error=access_denied&state=the-state", await cookieFor());
    expect(response.headers.get("location")).toBe("https://portal.example/admin/google?connect=denied");
    expect(connect.fn).not.toHaveBeenCalled();
  });
});

describe("the state cookie", () => {
  it("names why it refused, for the log", async () => {
    const sealed = await sealOAuthState({ state: "s", codeVerifier: "v", userId: "u", expiresAt: 1000 });
    expect(await verifyOAuthState(sealed, { state: "s", userId: "u", now: 2000 })).toEqual({ ok: false, reason: "expired" });
    expect(await verifyOAuthState(undefined, { state: "s", userId: "u" })).toEqual({ ok: false, reason: "missing" });
  });
});
