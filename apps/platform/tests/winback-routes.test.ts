import { beforeEach, describe, expect, it, vi } from "vitest";
import { newPublicId } from "@/lib/ids";
import { signUnsubscribeToken } from "@/lib/winback/unsubscribe-token";
import { svixSignatureFor } from "@/lib/email/resend-webhook";

/**
 * The public win-back routes, as a customer's browser, a mail provider and
 * Resend meet them.
 *
 * What would go wrong quietly: a forged token or unsigned webhook reaching
 * the database; a mail scanner's GET unsubscribing someone; and a handler
 * failure answered 200, so Resend never retries and a bounce is lost.
 */

const getDb = vi.fn(async () => ({}));
const unsubscribeRecipient = vi.fn(async (..._a: unknown[]) => ({ ok: true, businessName: "Acme" }) as const);
const routeDeliveryEvent = vi.fn(async (..._a: unknown[]): Promise<"handled" | "unrouted"> => "handled");

vi.mock("@/db/client", () => ({ getDb: () => getDb() }));
vi.mock("@/db/repositories/admin/winback", () => ({
  unsubscribeRecipient: (...a: unknown[]) => unsubscribeRecipient(...a),
}));
vi.mock("@/db/repositories/admin/delivery-events", () => ({
  routeDeliveryEvent: (...a: unknown[]) => routeDeliveryEvent(...a),
}));

const WEBHOOK_SECRET = `whsec_${btoa("0123456789abcdef0123456789abcdef")}`;
const params = (token: string) => ({ params: Promise.resolve({ token }) });

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("AUTH_SECRET", "s".repeat(32));
  vi.stubEnv("RESEND_WEBHOOK_SECRET", WEBHOOK_SECRET);
  getDb.mockClear();
  unsubscribeRecipient.mockClear();
  routeDeliveryEvent.mockClear();
});

describe("the one-click unsubscribe endpoint", () => {
  it("unsubscribes on a mail provider's one-click POST", async () => {
    const { POST } = await import("@/app/api/unsubscribe/[token]/route");
    const publicId = newPublicId();
    const token = (await signUnsubscribeToken(publicId))!;
    const response = await POST(
      new Request(`https://portal.example/api/unsubscribe/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "x-nf-client-connection-ip": "203.0.113.9" },
        body: "List-Unsubscribe=One-Click",
      }),
      params(token),
    );
    expect(response.status).toBe(200);
    expect(unsubscribeRecipient).toHaveBeenCalledWith({}, publicId, { ipHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("sends the page's button back to the page", async () => {
    const { POST } = await import("@/app/api/unsubscribe/[token]/route");
    const token = (await signUnsubscribeToken(newPublicId()))!;
    const response = await POST(new Request(`https://portal.example/api/unsubscribe/${token}`, { method: "POST" }), params(token));
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(`/unsubscribe/${token}?done=1`);
  });

  it("never unsubscribes on a GET", async () => {
    const { GET } = await import("@/app/api/unsubscribe/[token]/route");
    const token = (await signUnsubscribeToken(newPublicId()))!;
    const response = await GET(new Request(`https://portal.example/api/unsubscribe/${token}`), params(token));
    expect(response.status).toBe(303);
    expect(unsubscribeRecipient).not.toHaveBeenCalled();
  });

  it("refuses a forged token before touching the database", async () => {
    const { POST } = await import("@/app/api/unsubscribe/[token]/route");
    const forged = `${newPublicId()}.bm90LXNpZ25lZA`;
    const response = await POST(new Request(`https://portal.example/api/unsubscribe/${forged}`, { method: "POST" }), params(forged));
    expect(response.status).toBe(404);
    expect(getDb).not.toHaveBeenCalled();
  });

  it("answers 429 when the address is rate limited", async () => {
    const { POST } = await import("@/app/api/unsubscribe/[token]/route");
    unsubscribeRecipient.mockResolvedValueOnce({ ok: false, reason: "rate_limited" } as never);
    const token = (await signUnsubscribeToken(newPublicId()))!;
    const response = await POST(new Request(`https://portal.example/api/unsubscribe/${token}`, { method: "POST" }), params(token));
    expect(response.status).toBe(429);
  });
});

describe("the Resend webhook", () => {
  const body = JSON.stringify({
    type: "email.bounced",
    created_at: new Date().toISOString(),
    data: { email_id: "re_1", to: ["dana@example.test"], tags: { feature: "winback", organization: "org" } },
  });

  async function signed(raw = body) {
    const id = "msg_1";
    const ts = String(Math.floor(Date.now() / 1000));
    return new Request("https://portal.example/api/webhooks/resend", {
      method: "POST",
      headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": await svixSignatureFor(id, ts, raw, WEBHOOK_SECRET) },
      body: raw,
    });
  }

  it("routes a verified event to the feature that sent it", async () => {
    const { POST } = await import("@/app/api/webhooks/resend/route");
    const response = await POST(await signed());
    expect(response.status).toBe(200);
    expect(routeDeliveryEvent).toHaveBeenCalledWith({}, expect.objectContaining({ type: "bounced", emailId: "re_1", tags: { feature: "winback", organization: "org" } }));
  });

  it("refuses an unsigned delivery before touching the database", async () => {
    const { POST } = await import("@/app/api/webhooks/resend/route");
    const response = await POST(new Request("https://portal.example/api/webhooks/resend", { method: "POST", body }));
    expect(response.status).toBe(401);
    expect(getDb).not.toHaveBeenCalled();
  });

  it("refuses everything when no secret is configured", async () => {
    const { POST } = await import("@/app/api/webhooks/resend/route");
    const request = await signed();
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "");
    expect((await POST(request)).status).toBe(401);
  });

  it("answers 500 when the handler fails, so Resend retries", async () => {
    const { POST } = await import("@/app/api/webhooks/resend/route");
    routeDeliveryEvent.mockRejectedValueOnce(new Error("db down"));
    expect((await POST(await signed())).status).toBe(500);
  });

  it("acknowledges a verified event nobody records", async () => {
    const { POST } = await import("@/app/api/webhooks/resend/route");
    const raw = JSON.stringify({ type: "email.sent", created_at: new Date().toISOString(), data: { email_id: "re_1" } });
    const response = await POST(await signed(raw));
    expect(response.status).toBe(200);
    expect(routeDeliveryEvent).not.toHaveBeenCalled();
  });
});
