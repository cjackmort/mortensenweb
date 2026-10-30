import { beforeEach, describe, expect, it, vi } from "vitest";
import { newPublicId } from "@/lib/ids";

/**
 * The public booking routes, as a visitor's browser meets them.
 *
 * What would go wrong quietly: a script's form fill reaching the database,
 * a malformed body booking anything, a CORS header missing so the site's
 * own page cannot read the answer, and a failed calendar read answered as an
 * empty week. The repository is stubbed: its rules have their own tests.
 */

const getDb = vi.fn(async () => ({}));
const requestBooking = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({
  ok: true,
  status: "pending",
  bookingId: "B1",
  start: "2026-10-19T15:00:00.000Z",
  end: "2026-10-19T16:00:00.000Z",
  timeZone: "America/Denver",
}));
const openTimesForSite = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({
  ok: false,
  reason: "calendar_unavailable",
  message: "Online booking can't check the calendar right now.",
}));

vi.mock("@/db/client", () => ({ getDb: () => getDb() }));
vi.mock("@/db/repositories/admin/availability-public", () => ({
  requestBooking: (...a: unknown[]) => requestBooking(...a),
  openTimesForSite: (...a: unknown[]) => openTimesForSite(...a),
}));

let ipCounter = 0;
const SITE = newPublicId();
const params = { params: Promise.resolve({ sitePublicId: SITE }) };

function post(body: unknown, headers: Record<string, string> = {}) {
  ipCounter += 1;
  return new Request(`https://portal.example/api/public/sites/${SITE}/bookings`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-nf-client-connection-ip": `203.0.113.${ipCounter}`, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const GOOD = { start: "2026-10-19T15:00:00.000Z", name: "Dana", email: "dana@example.com" };

beforeEach(() => {
  requestBooking.mockClear();
  openTimesForSite.mockClear();
});

describe("POST bookings", () => {
  it("books, passing the page's origin on, and answers 201 with CORS", async () => {
    const { POST } = await import("@/app/api/public/sites/[sitePublicId]/bookings/route");
    const response = await POST(post(GOOD, { origin: "https://acme.example" }), params);
    expect(response.status).toBe(201);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toMatchObject({ status: "pending", booking: "B1" });
    expect(requestBooking.mock.calls[0]![1]).toMatchObject({
      sitePublicId: SITE,
      origin: "https://acme.example",
      portalIsLocal: false,
      manageUrl: "https://portal.example/dashboard/availability",
    });
  });

  it("answers a filled honeypot as if it worked, and books nothing", async () => {
    const { POST } = await import("@/app/api/public/sites/[sitePublicId]/bookings/route");
    const response = await POST(post({ ...GOOD, company: "SEO Experts" }), params);
    expect(response.status).toBe(202);
    expect(requestBooking).not.toHaveBeenCalled();
  });

  it("refuses bad input before touching the database", async () => {
    const { POST } = await import("@/app/api/public/sites/[sitePublicId]/bookings/route");
    expect((await POST(post("{nope"), params)).status).toBe(400);
    expect((await POST(post({ ...GOOD, email: "x" }), params)).status).toBe(400);
    expect((await POST(post({ ...GOOD, note: "x".repeat(5000) }), params)).status).toBe(413);
    const unknown = await POST(post(GOOD), { params: Promise.resolve({ sitePublicId: "not-a-site" }) });
    expect(unknown.status).toBe(404);
    expect(requestBooking).not.toHaveBeenCalled();
  });

  it("maps a taken slot to 409 and a foreign page to 403", async () => {
    const { POST } = await import("@/app/api/public/sites/[sitePublicId]/bookings/route");
    requestBooking.mockResolvedValueOnce({ ok: false, reason: "slot_taken", message: "Sorry, that time was just taken." });
    expect((await POST(post(GOOD), params)).status).toBe(409);
    requestBooking.mockResolvedValueOnce({ ok: false, reason: "origin", message: "No." });
    expect((await POST(post(GOOD), params)).status).toBe(403);
  });

  it("slows one address down", async () => {
    const { POST } = await import("@/app/api/public/sites/[sitePublicId]/bookings/route");
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      statuses.push((await POST(post(GOOD, { "x-nf-client-connection-ip": "198.51.100.7" }), params)).status);
    }
    expect(statuses.slice(0, 6).every((s) => s === 201)).toBe(true);
    expect(statuses.slice(6)).toEqual([429, 429]);
  });
});

describe("GET availability", () => {
  it("is a 503 with a reason when the calendar cannot be read, never an empty week", async () => {
    const { GET } = await import("@/app/api/public/sites/[sitePublicId]/availability/route");
    const response = await GET(new Request(`https://portal.example/api/public/sites/${SITE}/availability?from=2026-10-19`), params);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: "calendar_unavailable" });
    expect(openTimesForSite.mock.calls[0]![2]).toEqual({ from: "2026-10-19", to: undefined });
  });
});
