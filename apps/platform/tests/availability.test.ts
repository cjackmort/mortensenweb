import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  appointmentBookings,
  availabilityDateOverrides,
  availabilitySettings,
  availabilityWeeklyHours,
  clients,
  connectedAccounts,
  sites,
} from "@/db/schema";
import {
  bookingAccess,
  getAvailability,
  isAvailabilitySetUp,
  previewSlots,
  removeDateOverride,
  saveDateOverride,
  saveRules,
  saveWeeklyHours,
} from "@/db/repositories/client/availability";
import { decideAppointment, listAppointments } from "@/db/repositories/client/availability-bookings";
import { calendarStatus, disconnectCalendar } from "@/db/repositories/client/availability-calendar";
import { completeConnect } from "@/db/repositories/client/connections";
import { openTimesForSite, requestBooking, type BookingInput } from "@/db/repositories/admin/availability-public";
import { AuthorizationError, NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import type { GoogleCalendarConfig } from "@/lib/connections/providers/google-calendar";
import type { EmailMessage, SendResult } from "@/lib/email/mailer";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * Availability and booking, against a real Postgres with the real migrations.
 *
 * The failures that matter are the quiet ones: two customers given the same
 * slot, a slot offered on top of something in the client's calendar because
 * the calendar could not be read, a declined customer never told, a page on
 * another website filling a client's diary, and one client's bookings
 * decided by another.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let globex: SeededTenant;
let acmeSite: string;
let globexSite: string;

process.env.CONNECTION_TOKEN_KEY = Buffer.alloc(32).toString("base64");
process.env.LEADS_REPLY_FROM_ADDRESS = "replies@portal.example";

// Monday 2026-10-19, 8 AM in Denver.
const NOW = new Date("2026-10-19T14:00:00.000Z");
const NINE_AM = new Date("2026-10-19T15:00:00.000Z");
const TEN_AM = new Date("2026-10-19T16:00:00.000Z");
const WEEKDAYS_9_TO_12 = JSON.stringify(
  Object.fromEntries([1, 2, 3, 4, 5].map((d) => [String(d), [{ start: "09:00", end: "12:00" }]])),
);

const outbox: EmailMessage[] = [];
async function send(message: EmailMessage): Promise<SendResult> {
  outbox.push(message);
  return { status: "sent", id: `msg-${outbox.length}` };
}

const CONFIG: GoogleCalendarConfig = {
  ok: true,
  config: { clientId: "client", clientSecret: "secret", redirectUri: "https://portal.example/cb", tokenKey: "k" },
};

async function rules(tenant: SeededTenant, overrides: Record<string, unknown> = {}) {
  return saveRules(
    db,
    tenant.ctx,
    {
      timeZone: "America/Denver",
      slotMinutes: "60",
      bufferMinutes: "0",
      minNoticeMinutes: "0",
      horizonDays: "14",
      requiresApproval: undefined,
      ...overrides,
    },
    NOW,
  );
}

function booking(start: Date, overrides: Partial<BookingInput> = {}): BookingInput {
  return {
    sitePublicId: acmeSite,
    origin: "https://acmeplumbing.example",
    request: { start, name: "Dana Customer", email: "dana@customer.example", phone: "801 555 0100", note: "Leaky tap" },
    portalIsLocal: false,
    manageUrl: "https://portal.example/dashboard/availability",
    ...overrides,
  };
}

const deps = { now: NOW, send };

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
  acme = await seedTenant(db, "Acme Plumbing");
  globex = await seedTenant(db, "Globex Roofing");
  await db.update(clients).set({ bookingEnabled: true }).where(eq(clients.id, acme.clientId));
  acmeSite = newPublicId();
  globexSite = newPublicId();
  await db.insert(sites).values([
    { publicId: acmeSite, organizationId: acme.organizationId, name: "Acme", primaryDomain: "acmeplumbing.example" },
    { publicId: globexSite, organizationId: globex.organizationId, name: "Globex", primaryDomain: "globex.example" },
  ]);
});

afterAll(async () => close());

beforeEach(async () => {
  outbox.length = 0;
  await rules(acme);
  await saveWeeklyHours(db, acme.ctx, WEEKDAYS_9_TO_12, NOW);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await db.delete(appointmentBookings);
  await db.delete(availabilityDateOverrides);
  await db.delete(availabilityWeeklyHours);
  await db.delete(availabilitySettings);
  await db.delete(connectedAccounts);
});

describe("who gets the page", () => {
  it("opens for a client with booking on, and not for one without", async () => {
    expect(await bookingAccess(db, acme.ctx)).toMatchObject({ allowed: true, bookingEnabled: true });
    expect(await bookingAccess(db, globex.ctx)).toMatchObject({ allowed: false, bookingEnabled: false });
  });

  it("opens for the agency's own account so it can be tried", async () => {
    await db.update(clients).set({ isInternal: true }).where(eq(clients.id, globex.clientId));
    expect(await bookingAccess(db, globex.ctx)).toEqual({ allowed: true, bookingEnabled: false, internal: true });
    await db.update(clients).set({ isInternal: false }).where(eq(clients.id, globex.clientId));
  });
});

describe("hours and rules", () => {
  it("counts as set up once any weekly hours exist", async () => {
    expect(await isAvailabilitySetUp(db, acme.ctx)).toBe(true);
    expect(await isAvailabilitySetUp(db, globex.ctx)).toBe(false);
    await saveWeeklyHours(db, acme.ctx, JSON.stringify({ 1: [] }), NOW);
    expect(await isAvailabilitySetUp(db, acme.ctx)).toBe(false);
  });

  it("saves a whole week, several ranges a day, and reads it back", async () => {
    const saved = await saveWeeklyHours(
      db,
      acme.ctx,
      JSON.stringify({ 2: [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "00:00" }] }),
      NOW,
    );
    expect(saved.ok).toBe(true);
    const view = await getAvailability(db, acme.ctx, NOW);
    expect(view.weekly[2]).toEqual([
      { start: 540, end: 720 },
      { start: 780, end: 1440 },
    ]);
    expect(view.weekly[1]).toEqual([]);
  });

  it("refuses hours that end before they start, and keeps the old week", async () => {
    const saved = await saveWeeklyHours(db, acme.ctx, JSON.stringify({ 3: [{ start: "17:00", end: "09:00" }] }), NOW);
    expect(saved).toEqual({ ok: false, message: "Wednesday: each block of hours needs a start before its end." });
    expect((await getAvailability(db, acme.ctx, NOW)).weekly[3]).toEqual([{ start: 540, end: 720 }]);
  });

  it("refuses a timezone it does not know and an impossible slot length", async () => {
    expect((await rules(acme, { timeZone: "Mars/Olympus" })).ok).toBe(false);
    expect((await rules(acme, { slotMinutes: "0" })).ok).toBe(false);
  });

  it("refuses every write while an operator is only viewing as the client", async () => {
    const viewing = tenantContextFrom(
      { userId: acme.userId, organizationId: acme.organizationId, role: "admin", status: "active", sessionEpoch: 0 },
      acme.organizationId,
      { impersonating: true },
    );
    await expect(saveWeeklyHours(db, viewing, WEEKDAYS_9_TO_12, NOW)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("closes a date and removes the closure, only for its own client", async () => {
    expect((await saveDateOverride(db, acme.ctx, { date: "2026-10-20", mode: "closed", start: "", end: "" }, NOW)).ok).toBe(true);
    const view = await getAvailability(db, acme.ctx, NOW);
    expect(view.overrides).toEqual([{ publicId: expect.any(String), date: "2026-10-20", ranges: [] }]);
    const closed = await openTimesForSite(db, acmeSite, { from: "2026-10-20", to: "2026-10-20" }, deps);
    expect(closed.ok && closed.availability.days[0]!.slots).toEqual([]);

    const id = view.overrides[0]!.publicId;
    await expect(removeDateOverride(db, globex.ctx, id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await removeDateOverride(db, acme.ctx, id)).ok).toBe(true);
  });

  it("refuses a day off in the past", async () => {
    const result = await saveDateOverride(db, acme.ctx, { date: "2026-10-18", mode: "closed", start: "", end: "" }, NOW);
    expect(result).toEqual({ ok: false, message: "That date has already passed." });
  });
});

describe("the public feed", () => {
  it("lists every day in the window with its open slots, in the business's zone", async () => {
    const result = await openTimesForSite(db, acmeSite, {}, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { availability } = result;
    expect(availability).toMatchObject({ timeZone: "America/Denver", timeZoneLabel: "Mountain Time", open: true, from: "2026-10-19", to: "2026-11-01" });
    expect(availability.days).toHaveLength(14);
    expect(availability.days[0]!.slots.map((s) => s.start)).toEqual([
      NINE_AM.toISOString(),
      TEN_AM.toISOString(),
      "2026-10-19T17:00:00.000Z",
    ]);
  });

  it("is unknown for a site whose client does not take bookings", async () => {
    expect(await openTimesForSite(db, globexSite, {}, deps)).toMatchObject({ ok: false, reason: "unknown_site" });
    expect(await requestBooking(db, booking(NINE_AM, { sitePublicId: globexSite, origin: null }), deps)).toMatchObject({
      ok: false,
      reason: "unknown_site",
    });
  });
});

describe("booking with instant confirmation", () => {
  it("confirms the slot, emails the customer and tells the client", async () => {
    const result = await requestBooking(db, booking(NINE_AM), deps);
    expect(result).toMatchObject({ ok: true, status: "confirmed", start: NINE_AM.toISOString() });

    const [row] = await db.select().from(appointmentBookings);
    expect(row).toMatchObject({ status: "confirmed", customerEmailStatus: "sent", clientEmailStatus: "sent" });
    const [toCustomer, toClient] = outbox;
    expect(toCustomer).toMatchObject({ to: "dana@customer.example", replyTo: acme.ctx && expect.stringContaining("@example.test") });
    expect(toCustomer!.subject).toMatch(/^Confirmed: Monday, October 19, 2026 at 9:00 AM MDT with Acme Plumbing$/);
    expect(toClient!.to).toMatch(/@example\.test$/);
    expect(toClient!.replyTo).toBe("dana@customer.example");
    expect(toClient!.subject).toMatch(/^New booking: Dana Customer/);
  });

  it("stops offering a slot once it is booked", async () => {
    await requestBooking(db, booking(NINE_AM), deps);
    const result = await openTimesForSite(db, acmeSite, { from: "2026-10-19", to: "2026-10-19" }, deps);
    expect(result.ok && result.availability.days[0]!.slots.map((s) => s.start)).not.toContain(NINE_AM.toISOString());
  });

  it("refuses a time the site never offered", async () => {
    const offGrid = new Date("2026-10-19T15:20:00.000Z");
    expect(await requestBooking(db, booking(offGrid), deps)).toMatchObject({ ok: false, reason: "slot_taken" });
    expect(await db.select().from(appointmentBookings)).toHaveLength(0);
  });

  it("escapes what the customer typed in the client's notice", async () => {
    await requestBooking(
      db,
      booking(NINE_AM, {
        request: { start: NINE_AM, name: "<b>Dana</b>", email: "dana@customer.example", phone: null, note: "<script>x</script>" },
      }),
      deps,
    );
    const notice = outbox.find((m) => m.subject.includes("New booking"))!;
    expect(notice.html).not.toContain("<script>");
    expect(notice.html).toContain("&lt;script&gt;");
  });
});

describe("two visitors, one slot", () => {
  it("lets exactly one of two simultaneous bookings have it", async () => {
    const results = await Promise.all([
      requestBooking(db, booking(TEN_AM), deps),
      requestBooking(db, booking(TEN_AM, { request: { start: TEN_AM, name: "Sam", email: "sam@customer.example", phone: null, note: null } }), deps),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([expect.objectContaining({ reason: "slot_taken" })]);
    expect(await db.select().from(appointmentBookings)).toHaveLength(1);
  });

  it("holds under a burst of five", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        requestBooking(db, booking(TEN_AM, { request: { start: TEN_AM, name: `V${i}`, email: `v${i}@customer.example`, phone: null, note: null } }), deps),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("is enforced by the database, not only by the code", async () => {
    await requestBooking(db, booking(TEN_AM), deps);
    await expect(
      db.insert(appointmentBookings).values({
        publicId: newPublicId(),
        organizationId: acme.organizationId,
        siteId: (await db.select({ id: sites.id }).from(sites).where(eq(sites.publicId, acmeSite)))[0]!.id,
        startsAt: TEN_AM,
        endsAt: new Date(TEN_AM.getTime() + 3_600_000),
        timeZone: "America/Denver",
        customerName: "Sneaky",
        customerEmail: "s@customer.example",
        status: "pending",
      }),
    ).rejects.toThrow();
  });
});

describe("booking with approval", () => {
  beforeEach(async () => {
    await rules(acme, { requiresApproval: "on" });
  });

  it("holds the slot as a request, emails nobody but the client, and lists it to decide", async () => {
    const result = await requestBooking(db, booking(NINE_AM), deps);
    expect(result).toMatchObject({ ok: true, status: "pending" });
    expect(outbox.map((m) => m.to)).toEqual([expect.stringMatching(/@example\.test$/)]);
    expect(outbox[0]!.subject).toMatch(/^Booking request: Dana Customer/);

    const lists = await listAppointments(db, acme.ctx, NOW);
    expect(lists.pending.map((b) => b.customerName)).toEqual(["Dana Customer"]);
    const feed = await openTimesForSite(db, acmeSite, { from: "2026-10-19", to: "2026-10-19" }, deps);
    expect(feed.ok && feed.availability.requiresApproval).toBe(true);
    expect(feed.ok && feed.availability.days[0]!.slots.map((s) => s.start)).not.toContain(NINE_AM.toISOString());
  });

  it("approves once, emails the customer once, and records it", async () => {
    await requestBooking(db, booking(NINE_AM), deps);
    outbox.length = 0;
    const [pending] = (await listAppointments(db, acme.ctx, NOW)).pending;

    const first = await decideAppointment(db, acme.ctx, pending!.publicId, "approve", deps);
    expect(first).toEqual({ ok: true, message: expect.stringContaining("Dana Customer was emailed.") });
    const second = await decideAppointment(db, acme.ctx, pending!.publicId, "approve", deps);
    expect(second).toEqual({ ok: false, message: "That booking is already confirmed." });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.subject).toMatch(/^Confirmed:/);
    const lists = await listAppointments(db, acme.ctx, NOW);
    expect(lists.upcoming[0]).toMatchObject({ status: "confirmed", customerEmailStatus: "sent" });
  });

  it("declines, tells the customer, and gives the slot back to the website", async () => {
    await requestBooking(db, booking(NINE_AM), deps);
    outbox.length = 0;
    const [pending] = (await listAppointments(db, acme.ctx, NOW)).pending;
    const result = await decideAppointment(db, acme.ctx, pending!.publicId, "decline", deps);
    expect(result.ok && result.message).toContain("The time is open on your website again.");
    expect(outbox[0]!.subject).toMatch(/couldn't take your booking/);
    const feed = await openTimesForSite(db, acmeSite, { from: "2026-10-19", to: "2026-10-19" }, deps);
    expect(feed.ok && feed.availability.days[0]!.slots.map((s) => s.start)).toContain(NINE_AM.toISOString());
  });

  it("says so when the customer's email did not go", async () => {
    await requestBooking(db, booking(NINE_AM), deps);
    const [pending] = (await listAppointments(db, acme.ctx, NOW)).pending;
    const failing = async (): Promise<SendResult> => ({ status: "failed", error: "Resend 500" });
    const result = await decideAppointment(db, acme.ctx, pending!.publicId, "decline", { now: NOW, send: failing });
    expect(result.ok && result.message).toContain("The email to Dana Customer didn't go through. Call them on 801 555 0100.");
    const [row] = await db.select().from(appointmentBookings);
    expect(row).toMatchObject({ customerEmailStatus: "failed", customerEmailError: "Resend 500" });
  });

  it("cancels a confirmed booking", async () => {
    await requestBooking(db, booking(NINE_AM), deps);
    const [pending] = (await listAppointments(db, acme.ctx, NOW)).pending;
    await decideAppointment(db, acme.ctx, pending!.publicId, "approve", deps);
    outbox.length = 0;
    const result = await decideAppointment(db, acme.ctx, pending!.publicId, "cancel", deps);
    expect(result.ok).toBe(true);
    expect(outbox[0]!.subject).toMatch(/^Cancelled:/);
  });

  it("will not let another client decide it", async () => {
    await requestBooking(db, booking(NINE_AM), deps);
    const [pending] = (await listAppointments(db, acme.ctx, NOW)).pending;
    await expect(decideAppointment(db, globex.ctx, pending!.publicId, "approve", deps)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listAppointments(db, globex.ctx, NOW)).pending).toEqual([]);
  });
});

describe("where a booking may come from", () => {
  it("takes the site's own pages and refuses another website's", async () => {
    expect(await requestBooking(db, booking(NINE_AM, { origin: "https://evil.example" }), deps)).toMatchObject({
      ok: false,
      reason: "origin",
    });
    expect(await requestBooking(db, booking(NINE_AM, { origin: "https://www.acmeplumbing.example" }), deps)).toMatchObject({ ok: true });
  });

  it("takes a localhost site only while the portal itself is local", async () => {
    expect(await requestBooking(db, booking(NINE_AM, { origin: "http://localhost:4331" }), deps)).toMatchObject({ reason: "origin" });
    expect(await requestBooking(db, booking(NINE_AM, { origin: "http://localhost:4331", portalIsLocal: true }), deps)).toMatchObject({
      ok: true,
    });
  });
});

describe("Google Calendar busy times", () => {
  async function connectCalendar(tenant = acme) {
    await completeConnect(
      db,
      tenant.ctx,
      "google_calendar",
      {
        externalId: "google-sub-1",
        displayName: "owner@acme.example",
        scope: "openid email https://www.googleapis.com/auth/calendar.freebusy",
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
      },
      NOW,
    );
  }

  function freeBusy(answer: () => Response) {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      return answer();
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  const busyAtNine = () =>
    Response.json({
      calendars: {
        "owner@acme.example": { busy: [{ start: "2026-10-19T15:00:00Z", end: "2026-10-19T15:30:00Z" }] },
      },
    });

  it("leaves out a slot the calendar is busy for, and reads the primary calendar by its address", async () => {
    await connectCalendar();
    const google = freeBusy(busyAtNine);
    const feed = await openTimesForSite(db, acmeSite, { from: "2026-10-19", to: "2026-10-19" }, { ...deps, config: CONFIG, fetchImpl: google.fetchImpl });
    expect(feed.ok && feed.availability.days[0]!.slots.map((s) => s.start)).toEqual([TEN_AM.toISOString(), "2026-10-19T17:00:00.000Z"]);
    expect(google.calls[0]!.url).toBe("https://www.googleapis.com/calendar/v3/freeBusy");
    expect(google.calls[0]!.body).toMatchObject({ items: [{ id: "owner@acme.example" }] });
    expect(await requestBooking(db, booking(NINE_AM), { ...deps, config: CONFIG, fetchImpl: google.fetchImpl })).toMatchObject({
      reason: "slot_taken",
    });
  });

  it("asks Google at most once every few minutes", async () => {
    await connectCalendar();
    const google = freeBusy(busyAtNine);
    const at = (ms: number) => ({ ...deps, now: new Date(NOW.getTime() + ms), config: CONFIG, fetchImpl: google.fetchImpl });
    await openTimesForSite(db, acmeSite, {}, at(0));
    await openTimesForSite(db, acmeSite, {}, at(60_000));
    expect(google.calls).toHaveLength(1);
    await openTimesForSite(db, acmeSite, {}, at(6 * 60_000));
    expect(google.calls).toHaveLength(2);
  });

  it("offers nothing, and says why, when the calendar cannot be read", async () => {
    await connectCalendar();
    const google = freeBusy(() => new Response("backend error", { status: 503 }));
    const options = { ...deps, config: CONFIG, fetchImpl: google.fetchImpl };
    expect(await openTimesForSite(db, acmeSite, {}, options)).toMatchObject({ ok: false, reason: "calendar_unavailable" });
    expect(await requestBooking(db, booking(NINE_AM), options)).toMatchObject({ ok: false, reason: "calendar_unavailable" });

    const preview = await previewSlots(db, acme.ctx, options);
    expect(preview.slots).toBeNull();
    expect(preview.calendar).toMatchObject({ kind: "failed", reason: "unavailable" });
    expect((await calendarStatus(db, acme.ctx)).lastError).toMatch(/503/);
  });

  it("asks for a reconnect when Google says the grant is gone, not on a rate limit", async () => {
    await connectCalendar();
    const limited = freeBusy(() => new Response('{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}', { status: 403 }));
    await previewSlots(db, acme.ctx, { ...deps, config: CONFIG, fetchImpl: limited.fetchImpl });
    expect((await calendarStatus(db, acme.ctx)).connection?.status).toBe("connected");

    const refused = freeBusy(() => new Response("unauthorized", { status: 401 }));
    const preview = await previewSlots(db, acme.ctx, { ...deps, now: new Date(NOW.getTime() + 600_000), config: CONFIG, fetchImpl: refused.fetchImpl });
    expect(preview.calendar).toMatchObject({ kind: "failed", reason: "needs_reconnect" });
    expect((await calendarStatus(db, acme.ctx)).connection?.status).toBe("needs_reconnect");
  });

  it("does not revoke Google access that Search Console shares on disconnect", async () => {
    await connectCalendar();
    await completeConnect(
      db,
      acme.ctx,
      "google",
      {
        externalId: "google-sub-1",
        displayName: "owner@acme.example",
        scope: "openid email https://www.googleapis.com/auth/webmasters.readonly",
        accessToken: "sc-access",
        refreshToken: "sc-refresh",
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
      },
      NOW,
    );
    const revoke = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", revoke);
    expect(await disconnectCalendar(db, acme.ctx, NOW)).toBe(true);
    expect(revoke).not.toHaveBeenCalled();
    expect((await calendarStatus(db, acme.ctx)).connection).toBeNull();
  });

  it("revokes the grant on disconnect when nothing else uses it", async () => {
    await connectCalendar();
    const revoke = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", revoke);
    await disconnectCalendar(db, acme.ctx, NOW);
    expect(revoke).toHaveBeenCalledWith("https://oauth2.googleapis.com/revoke", expect.anything());
  });
});
