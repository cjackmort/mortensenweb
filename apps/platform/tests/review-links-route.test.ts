import { beforeEach, describe, expect, it, vi } from "vitest";
import { newPublicId } from "@/lib/ids";
import { signReviewToken } from "@/lib/reviews/tokens";
import { REVIEW_LINK_LIMIT_PER_MINUTE } from "@/lib/reviews/link-limiter";

/**
 * The public review routes, as a customer's browser and a mail provider meet
 * them.
 *
 * What would go wrong quietly: a forged link querying the database (anyone
 * could keep Neon awake), a mail scanner's GET or HEAD unsubscribing someone
 * or counting as a click, and a click link edited into an unsubscribe link.
 */

const getDb = vi.fn(async () => ({}));
const recordReviewClick = vi.fn(async (..._a: unknown[]): Promise<string | null> => "https://g.page/r/CabcdEFGhij1EBM/review");
const unsubscribeReviewRequest = vi.fn(async (..._a: unknown[]): Promise<{ businessName: string } | null> => ({
  businessName: "Acme Plumbing",
}));

vi.mock("@/db/client", () => ({ getDb: () => getDb() }));
vi.mock("@/db/repositories/admin/reviews", () => ({
  recordReviewClick: (...a: unknown[]) => recordReviewClick(...a),
  unsubscribeReviewRequest: (...a: unknown[]) => unsubscribeReviewRequest(...a),
}));

const SECRET = "r".repeat(32);
let ipCounter = 0;

function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

function req(path: string, init: RequestInit & { ip?: string } = {}) {
  const { ip = nextIp(), ...rest } = init;
  return new Request(`https://portal.example${path}`, {
    ...rest,
    headers: { "x-nf-client-connection-ip": ip, ...(rest.headers as Record<string, string> | undefined) },
  });
}

const params = (token: string) => ({ params: Promise.resolve({ token }) });

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", SECRET);
  getDb.mockClear();
  recordReviewClick.mockClear();
  unsubscribeReviewRequest.mockClear();
});

describe("the tracked link", () => {
  it("records the click and redirects to the review form, without leaking the token", async () => {
    const { GET } = await import("@/app/review/[token]/route");
    const publicId = newPublicId();
    const token = (await signReviewToken(publicId, "click"))!;

    const response = await GET(req(`/review/${token}`), params(token));
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://g.page/r/CabcdEFGhij1EBM/review");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(recordReviewClick).toHaveBeenCalledWith({}, publicId);
  });

  it("refuses a forged link without touching the database", async () => {
    const { GET } = await import("@/app/review/[token]/route");
    const forged = `${newPublicId()}.AAAAAAAAAAAAAAAAAAAAAA`;
    expect((await GET(req(`/review/${forged}`), params(forged))).status).toBe(404);
    expect(getDb).not.toHaveBeenCalled();
  });

  it("refuses an unsubscribe token used as a click link", async () => {
    const { GET } = await import("@/app/review/[token]/route");
    const stop = (await signReviewToken(newPublicId(), "stop"))!;
    expect((await GET(req(`/review/${stop}`), params(stop))).status).toBe(404);
    expect(recordReviewClick).not.toHaveBeenCalled();
  });

  it("is a 404 for a request that no longer exists", async () => {
    const { GET } = await import("@/app/review/[token]/route");
    recordReviewClick.mockResolvedValueOnce(null);
    const token = (await signReviewToken(newPublicId(), "click"))!;
    expect((await GET(req(`/review/${token}`), params(token))).status).toBe(404);
  });

  it("does not count a scanner's HEAD as a click", async () => {
    const { HEAD } = await import("@/app/review/[token]/route");
    const token = (await signReviewToken(newPublicId(), "click"))!;
    expect((await HEAD(req(`/review/${token}`, { method: "HEAD" }), params(token))).status).toBe(200);
    expect(recordReviewClick).not.toHaveBeenCalled();
    expect(getDb).not.toHaveBeenCalled();
  });

  it("stops one address hammering a link before it reaches the database", async () => {
    const { GET } = await import("@/app/review/[token]/route");
    const token = (await signReviewToken(newPublicId(), "click"))!;
    const ip = nextIp();
    for (let i = 0; i < REVIEW_LINK_LIMIT_PER_MINUTE; i += 1) {
      expect((await GET(req(`/review/${token}`, { ip }), params(token))).status).toBe(302);
    }
    getDb.mockClear();
    expect((await GET(req(`/review/${token}`, { ip }), params(token))).status).toBe(429);
    expect(getDb).not.toHaveBeenCalled();
  });
});

describe("unsubscribing", () => {
  it("answers a mail provider's one-click POST with a plain 200", async () => {
    const { POST } = await import("@/app/review/[token]/unsubscribe/route");
    const publicId = newPublicId();
    const token = (await signReviewToken(publicId, "stop"))!;
    const response = await POST(
      req(`/review/${token}/unsubscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      }),
      params(token),
    );
    expect(response.status).toBe(200);
    expect(unsubscribeReviewRequest).toHaveBeenCalledWith({}, publicId);
  });

  it("sends the page's own button back to the page to say it is done", async () => {
    const { POST } = await import("@/app/review/[token]/unsubscribe/route");
    const token = (await signReviewToken(newPublicId(), "stop"))!;
    const response = await POST(
      req(`/review/${token}/unsubscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "",
      }),
      params(token),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(`/review/${encodeURIComponent(token)}/stop?done=1`);
  });

  it("never unsubscribes on a GET, which mail scanners send to every link", async () => {
    const { GET } = await import("@/app/review/[token]/unsubscribe/route");
    const token = (await signReviewToken(newPublicId(), "stop"))!;
    const response = await GET(req(`/review/${token}/unsubscribe`), params(token));
    expect(response.status).toBe(303);
    expect(unsubscribeReviewRequest).not.toHaveBeenCalled();
  });

  it("refuses a click token edited into an unsubscribe link", async () => {
    const { POST } = await import("@/app/review/[token]/unsubscribe/route");
    const click = (await signReviewToken(newPublicId(), "click"))!;
    const response = await POST(req(`/review/${click}/unsubscribe`, { method: "POST", body: "" }), params(click));
    expect(response.status).toBe(404);
    expect(unsubscribeReviewRequest).not.toHaveBeenCalled();
    expect(getDb).not.toHaveBeenCalled();
  });
});
