import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { businessProfiles, eventBookings, leads, sites } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { parseSubmission } from "@/lib/growth/netlify-forms";
import {
  buildBookingApprovedEmail,
  decisionNotice,
  eventsPageUrl,
  fetchUploadedImage,
  isAllowedUploadUrl,
  isIsoDate,
  parseStartTime,
  readBookingRequest,
  uploadUrlOf,
} from "@/lib/growth/bookings";
import { recordLead, type FormsSite } from "@/db/repositories/admin/leads";
import { listUpcomingEvents, findListedEventLogo } from "@/db/repositories/admin/event-bookings";
import {
  approveBooking,
  bookingCalendar,
  bookingStatesFor,
  declineBooking,
  holdBooking,
  readBookingLogo,
  setBookingListed,
  takesBookings,
  type BookingDeps,
} from "@/db/repositories/client/event-bookings";
import { deleteLead, listLeads, setLeadArchived } from "@/db/repositories/client/leads";
import { AuthorizationError, NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import type { EmailMessage, SendResult } from "@/lib/email/mailer";
import type { StorageDriver } from "@/lib/storage";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * Booking requests: approve, decline, and the public list of upcoming shows.
 *
 * The failures that matter here are quiet ones — a band emailed twice, a
 * declined act appearing on a client's website, a performer's email address
 * reaching a public feed, the portal fetching an address a stranger typed into
 * a form — and each has a test below.
 */

let db: Database;
let close: () => Promise<void>;
let venue: SeededTenant;
let other: SeededTenant;
let venueSite: FormsSite & { sitePublicId: string };
let otherSite: FormsSite;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const NOW = new Date("2026-10-12T18:00:00.000Z");

const outbox: EmailMessage[] = [];
async function send(message: EmailMessage): Promise<SendResult> {
  outbox.push(message);
  return { status: "sent", id: `msg-${outbox.length}` };
}

function memoryStore(): StorageDriver & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async put({ key, bytes, contentType }) {
      objects.set(key, bytes);
      return { key, size: bytes.byteLength, contentType };
    },
    async get(key) {
      const bytes = objects.get(key);
      return bytes ? { bytes, contentType: "application/octet-stream" } : null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

let logos: ReturnType<typeof memoryStore>;
const LOGO_URL = "https://netlify-form-uploads.s3.amazonaws.com/abc/logo.png";

function deps(overrides: Partial<BookingDeps> = {}): BookingDeps {
  return {
    send,
    now: NOW,
    logos,
    loadSubmission: async () => ({ data: { logo: { filename: "logo.png", url: LOGO_URL } } }),
    fetchImage: async () => ({ ok: true, bytes: PNG, contentType: "image/png", extension: "png" }),
    ...overrides,
  };
}

async function addSite(tenant: SeededTenant, name: string, primaryDomain: string | null) {
  const [row] = await db
    .insert(sites)
    .values({
      publicId: newPublicId(),
      organizationId: tenant.organizationId,
      name,
      primaryDomain,
      netlifySiteId: `netlify-${name}`,
    })
    .returning({
      id: sites.id,
      publicId: sites.publicId,
      organizationId: sites.organizationId,
      netlifySiteId: sites.netlifySiteId,
    });
  return row!;
}

function bookingSubmission(fields: Record<string, unknown> = {}, formName = "event-booking") {
  return {
    id: newPublicId(),
    form_name: formName,
    created_at: "2026-10-10T03:00:00.000Z",
    data: {
      name: "Riley Moss",
      email: "riley@band.example",
      phone: "801-555-0142",
      act_name: "The Late Shift",
      genre: "Indie rock",
      preferred_date: "2026-11-14",
      expected_attendance: "50–100",
      selling_tickets: "Yes",
      ticket_terms: "Agreed",
      logo: { filename: "late-shift.png", url: LOGO_URL, type: "image/png", size: 16 },
      links: "https://instagram.com/thelateshift",
      message: "Four-piece, 45 minute set.",
      referrer: "https://redwood-room.example/after-hours",
      ...fields,
    },
  };
}

async function recordBooking(site: FormsSite, fields: Record<string, unknown> = {}, formName?: string) {
  const parsed = parseSubmission(bookingSubmission(fields, formName));
  if (!parsed.ok) throw new Error("fixture did not parse");
  const result = await recordLead(db, site, parsed.lead);
  if (!result.created) throw new Error("fixture was a duplicate");
  const [row] = await db
    .select({ publicId: leads.publicId })
    .from(leads)
    .where(eq(leads.id, result.leadId));
  return row!.publicId;
}

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  venue = await seedTenant(db, "Redwood Room");
  other = await seedTenant(db, "Elsewhere");
  const site = await addSite(venue, "redwood-room", "redwood-room.example");
  venueSite = { ...site, sitePublicId: site.publicId };
  otherSite = await addSite(other, "elsewhere", null);
  await db.insert(businessProfiles).values({
    organizationId: venue.organizationId,
    details: { businessName: "Redwood Room", email: "info@redwood-room.example" },
  });
});

afterAll(async () => {
  await close();
});

beforeEach(() => {
  outbox.length = 0;
  logos = memoryStore();
  vi.unstubAllEnvs();
  vi.stubEnv("RESEND_FROM_ADDRESS", '"Mortensen Web Co." <hello@mortensenweb.example>');
  vi.stubEnv("BUSINESS_TIMEZONE", "America/Denver");
});

// ---------------------------------------------------------------------------

describe("reading a booking request", () => {
  it("keeps every field's name, so the request is read by name rather than by label", () => {
    const parsed = parseSubmission(bookingSubmission());
    if (!parsed.ok) throw new Error("did not parse");
    expect(readBookingRequest(parsed.lead.fields)).toEqual({
      actName: "The Late Shift",
      genre: "Indie rock",
      requestedDate: "2026-11-14",
      expectedAttendance: "50–100",
      sellingTickets: "yes",
      logoName: "late-shift.png",
      links: "https://instagram.com/thelateshift",
    });
  });

  it("records an uploaded file by its name, never by its link", () => {
    const parsed = parseSubmission(bookingSubmission());
    if (!parsed.ok) throw new Error("did not parse");
    const logo = parsed.lead.fields.find((f) => f.key === "logo");
    expect(logo?.value).toBe("late-shift.png");
    expect(JSON.stringify(parsed.lead.fields)).not.toContain("amazonaws");
  });

  it("finds an upload that Netlify's ordered field list left out", () => {
    const parsed = parseSubmission({
      id: "x1",
      form_name: "event-booking",
      ordered_human_fields: [{ name: "act_name", title: "Act name", value: "Static Bloom" }],
      data: { act_name: "Static Bloom", logo: { filename: "bloom.webp", url: LOGO_URL } },
    });
    if (!parsed.ok) throw new Error("did not parse");
    expect(readBookingRequest(parsed.lead.fields).logoName).toBe("bloom.webp");
  });

  it("treats a date that is not a real calendar day as no date", () => {
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-11-14")).toBe(true);
    expect(readBookingRequest([{ key: "preferred_date", label: "Date", value: "next friday" }]).requestedDate).toBeNull();
  });

  it("tells a blank start time from a nonsense one", () => {
    expect(parseStartTime("")).toBeNull();
    expect(parseStartTime("21:30")).toBe("21:30");
    expect(parseStartTime("9pm")).toBeUndefined();
    expect(parseStartTime("24:00")).toBeUndefined();
  });

  it("reads 'Not sure yet' about tickets as unsure, not as no", () => {
    const request = readBookingRequest([{ key: "selling_tickets", label: "Tickets", value: "Not sure yet" }]);
    expect(request.sellingTickets).toBe("unsure");
  });
});

describe("fetching an uploaded logo", () => {
  it("only fetches over https from where Netlify keeps uploads", () => {
    expect(isAllowedUploadUrl(LOGO_URL)).toBe(true);
    expect(isAllowedUploadUrl("http://netlify-form-uploads.s3.amazonaws.com/a.png")).toBe(false);
    expect(isAllowedUploadUrl("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isAllowedUploadUrl("https://localhost/a.png")).toBe(false);
    expect(isAllowedUploadUrl("https://evil.example/a.png")).toBe(false);
    expect(isAllowedUploadUrl("https://user:pass@x.s3.amazonaws.com/a.png")).toBe(false);
    expect(isAllowedUploadUrl("https://amazonaws.com.evil.example/a.png")).toBe(false);
  });

  it("ignores a link a visitor typed into the logo field", () => {
    expect(uploadUrlOf("https://internal.service.local/admin")).toBeNull();
    expect(uploadUrlOf({ url: LOGO_URL })).toBe(LOGO_URL);
  });

  it("refuses a redirect that leaves the allowed hosts", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: "https://10.0.0.5/secret" } }),
    );
    const result = await fetchUploadedImage(LOGO_URL, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ ok: false, reason: "unreachable" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses a file that is not an image, whatever it claims", async () => {
    const fetchImpl = async () =>
      new Response("<svg onload=alert(1)>", { headers: { "content-type": "image/png" } });
    const result = await fetchUploadedImage(LOGO_URL, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ ok: false, reason: "not_an_image" });
  });

  it("refuses a file over the size limit while reading it", async () => {
    const big = new Uint8Array(6 * 1024 * 1024);
    big.set(PNG);
    const fetchImpl = async () => new Response(big);
    const result = await fetchUploadedImage(LOGO_URL, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  it("accepts a PNG and says so from its bytes", async () => {
    const fetchImpl = async () => new Response(PNG, { headers: { "content-type": "text/html" } });
    const result = await fetchUploadedImage(LOGO_URL, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toMatchObject({ ok: true, contentType: "image/png", extension: "png" });
  });
});

describe("the 'you're booked' email", () => {
  it("is from the business, answered by the business, and escapes what the performer typed", () => {
    const message = buildBookingApprovedEmail({
      businessName: "Redwood Room",
      senderAddress: "hello@mortensenweb.example",
      replyTo: "info@redwood-room.example",
      to: "riley@band.example",
      actName: "<script>The Late Shift</script>",
      eventDate: "2026-11-14",
      startTime: "21:00",
      eventsUrl: "https://redwood-room.example/events",
    });
    expect(message.from).toBe('"Redwood Room" <hello@mortensenweb.example>');
    expect(message.replyTo).toBe("info@redwood-room.example");
    expect(message.bcc).toBe("info@redwood-room.example");
    expect(message.text).toContain("Saturday, November 14, 2026 at 9 PM");
    expect(message.html).not.toContain("<script>");
    expect(message.subject).not.toMatch(/[\r\n]/);
  });

  it("links to the site's own address, never one from the submission", () => {
    expect(eventsPageUrl({ primaryDomain: "redwood-room.example", productionUrl: null })).toBe(
      "https://redwood-room.example/events",
    );
    expect(eventsPageUrl({ primaryDomain: null, productionUrl: "https://x.netlify.app" })).toBe(
      "https://x.netlify.app/events",
    );
    expect(eventsPageUrl({ primaryDomain: null, productionUrl: null, netlifySiteName: "venue-after-hours" })).toBe(
      "https://venue-after-hours.netlify.app/events",
    );
    expect(eventsPageUrl({ primaryDomain: "not a domain", productionUrl: null, netlifySiteName: "../evil" })).toBeNull();
  });
});

describe("approving a booking", () => {
  it("lists the show, stores the logo, emails the performer once, and marks the request won", async () => {
    const lead = await recordBooking(venueSite);

    const result = await approveBooking(db, venue.ctx, lead, { eventDate: "2026-11-14", startTime: "21:00" }, deps());
    expect(result.ok).toBe(true);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toBe("riley@band.example");
    expect(outbox[0]!.text).toContain("https://redwood-room.example/events");

    const [row] = await db.select().from(leads).where(eq(leads.publicId, lead));
    expect(row!.status).toBe("won");
    // Decided from the inbox without opening it: no longer counted as unread.
    expect(row!.readAt).not.toBeNull();

    const states = await bookingStatesFor(db, venue.ctx, [lead]);
    expect(states.get(lead)).toMatchObject({
      decision: "approved",
      actName: "The Late Shift",
      eventDate: "2026-11-14",
      startTime: "21:00",
      hasLogo: true,
      emailStatus: "sent",
      removed: false,
    });
    expect(logos.objects.size).toBe(1);

    const again = await approveBooking(db, venue.ctx, lead, { eventDate: "2026-11-14", startTime: "" }, deps());
    expect(again.ok).toBe(false);
    expect(outbox).toHaveLength(1);
  });

  it("refuses a date that has already passed", async () => {
    const lead = await recordBooking(venueSite);
    const result = await approveBooking(db, venue.ctx, lead, { eventDate: "2026-10-01", startTime: "" }, deps());
    expect(result).toMatchObject({ ok: false });
    expect(outbox).toHaveLength(0);
  });

  it("still approves when the logo cannot be fetched, and says so", async () => {
    const lead = await recordBooking(venueSite);
    const result = await approveBooking(
      db,
      venue.ctx,
      lead,
      { eventDate: "2026-11-20", startTime: "" },
      deps({ fetchImage: async () => ({ ok: false, reason: "unreachable" }) }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message).toContain("logo couldn't be fetched");
    expect(logos.objects.size).toBe(0);
  });

  it("refuses an ordinary contact form's lead", async () => {
    const lead = await recordBooking(venueSite, {}, "contact");
    const result = await approveBooking(db, venue.ctx, lead, { eventDate: "2026-11-14", startTime: "" }, deps());
    expect(result).toEqual({ ok: false, message: "This enquiry isn't a booking request." });
  });

  it("cannot be done to another client's request", async () => {
    const lead = await recordBooking(venueSite);
    await expect(
      approveBooking(db, other.ctx, lead, { eventDate: "2026-11-14", startTime: "" }, deps()),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("cannot be done while an operator is viewing as the client", async () => {
    const lead = await recordBooking(venueSite);
    const viewing = tenantContextFrom(
      { userId: venue.userId, organizationId: venue.organizationId, role: "admin", status: "active", sessionEpoch: 0 },
      venue.organizationId,
      { impersonating: true },
    );
    await expect(
      approveBooking(db, viewing, lead, { eventDate: "2026-11-14", startTime: "" }, deps()),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("declining a booking", () => {
  it("emails nobody, marks the request lost, and can still be approved afterwards", async () => {
    const lead = await recordBooking(venueSite);
    const declined = await declineBooking(db, venue.ctx, lead, { now: NOW });
    expect(declined.ok).toBe(true);
    expect(outbox).toHaveLength(0);
    const [row] = await db.select().from(leads).where(eq(leads.publicId, lead));
    expect(row!.status).toBe("lost");
    expect(row!.readAt).not.toBeNull();

    const approved = await approveBooking(db, venue.ctx, lead, { eventDate: "2026-12-05", startTime: "" }, deps());
    expect(approved.ok).toBe(true);
    expect(outbox).toHaveLength(1);
  });
});

describe("holding a date on the calendar", () => {
  it("saves the date and time without listing the show or emailing anyone", async () => {
    const lead = await recordBooking(venueSite, { act_name: "Pencilled In" });

    const held = await holdBooking(db, venue.ctx, lead, { eventDate: "2027-05-14", startTime: "21:30" }, { now: NOW });
    expect(held).toEqual({
      ok: true,
      message:
        "Saved to your calendar for Friday, May 14, 2027 · 9:30 PM. It isn't on your site yet, and they haven't been emailed.",
    });
    expect(outbox).toHaveLength(0);

    expect((await bookingStatesFor(db, venue.ctx, [lead])).get(lead)).toMatchObject({
      decision: "held",
      eventDate: "2027-05-14",
      startTime: "21:30",
      emailStatus: null,
    });
    const events = await listUpcomingEvents(db, venueSite.sitePublicId, "2027-05-01");
    expect(events?.some((e) => e.actName === "Pencilled In")).toBe(false);

    const [row] = await db.select().from(leads).where(eq(leads.publicId, lead));
    expect(row!.status).toBe("contacted");
    expect(row!.readAt).not.toBeNull();
  });

  it("puts the held date on the site when approved, and emails them once", async () => {
    const lead = await recordBooking(venueSite, { act_name: "Then Approved" });
    await holdBooking(db, venue.ctx, lead, { eventDate: "2027-05-15", startTime: "20:00" }, { now: NOW });

    const approved = await approveBooking(db, venue.ctx, lead, { eventDate: "2027-05-15", startTime: "20:00" }, deps());
    expect(approved.ok).toBe(true);
    expect(outbox).toHaveLength(1);
    const events = await listUpcomingEvents(db, venueSite.sitePublicId, "2027-05-01");
    expect(events?.find((e) => e.actName === "Then Approved")).toMatchObject({
      eventDate: "2027-05-15",
      startTime: "20:00",
    });
  });

  it("can move a held date, but not a show that is already on the site", async () => {
    const lead = await recordBooking(venueSite, { act_name: "Moved Around" });
    await holdBooking(db, venue.ctx, lead, { eventDate: "2027-05-21", startTime: "" }, { now: NOW });
    const moved = await holdBooking(db, venue.ctx, lead, { eventDate: "2027-05-22", startTime: "22:00" }, { now: NOW });
    expect(moved.ok).toBe(true);
    expect((await bookingStatesFor(db, venue.ctx, [lead])).get(lead)).toMatchObject({
      decision: "held",
      eventDate: "2027-05-22",
      startTime: "22:00",
    });

    await approveBooking(db, venue.ctx, lead, { eventDate: "2027-05-22", startTime: "22:00" }, deps());
    const again = await holdBooking(db, venue.ctx, lead, { eventDate: "2027-05-29", startTime: "" }, { now: NOW });
    expect(again).toEqual({
      ok: false,
      message: "It's already on your site. Take it off the site first to move it.",
    });
  });

  it("refuses a date that has passed, or a time that isn't one", async () => {
    const lead = await recordBooking(venueSite);
    expect(await holdBooking(db, venue.ctx, lead, { eventDate: "2026-10-01", startTime: "" }, { now: NOW })).toMatchObject({
      ok: false,
    });
    expect(await holdBooking(db, venue.ctx, lead, { eventDate: "2027-05-14", startTime: "late" }, { now: NOW })).toMatchObject({
      ok: false,
    });
  });

  it("cannot be done to another client's request, or while an operator is viewing", async () => {
    const lead = await recordBooking(venueSite);
    await expect(
      holdBooking(db, other.ctx, lead, { eventDate: "2027-05-14", startTime: "" }, { now: NOW }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const viewing = tenantContextFrom(
      { userId: venue.userId, organizationId: venue.organizationId, role: "admin", status: "active", sessionEpoch: 0 },
      venue.organizationId,
      { impersonating: true },
    );
    await expect(
      holdBooking(db, viewing, lead, { eventDate: "2027-05-14", startTime: "" }, { now: NOW }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("records the decision on an archived request as won, and leaves it in Archived", async () => {
    const lead = await recordBooking(venueSite, { act_name: "Stays Archived" });
    await setLeadArchived(db, venue.ctx, lead, true);
    await holdBooking(db, venue.ctx, lead, { eventDate: "2027-05-14", startTime: "" }, { now: NOW });
    await approveBooking(db, venue.ctx, lead, { eventDate: "2027-05-14", startTime: "" }, deps());

    const [row] = await db.select().from(leads).where(eq(leads.publicId, lead));
    expect(row!.status).toBe("won");
    expect(row!.archivedAt).not.toBeNull();
    const inbox = (await listLeads(db, venue.ctx, { view: "open" })).leads.map((l) => l.publicId);
    const archived = (await listLeads(db, venue.ctx, { view: "archived" })).leads.map((l) => l.publicId);
    expect(inbox).not.toContain(lead);
    expect(archived).toContain(lead);
  });

  it("records a decline on an archived request as lost", async () => {
    const lead = await recordBooking(venueSite, { act_name: "Archived No" });
    await setLeadArchived(db, venue.ctx, lead, true);
    await declineBooking(db, venue.ctx, lead, { now: NOW });
    const [row] = await db.select().from(leads).where(eq(leads.publicId, lead));
    expect(row).toMatchObject({ status: "lost", archivedAt: expect.any(Date) });
  });
});

describe("the booking calendar", () => {
  it("shows a month's booked, held and requested nights in date order, and nothing declined, removed or another client's", async () => {
    const booked = await recordBooking(venueSite, { act_name: "June Booked", preferred_date: "2027-06-04" });
    const held = await recordBooking(venueSite, { act_name: "June Held", preferred_date: "2027-06-11" });
    await recordBooking(venueSite, { act_name: "June Asked", preferred_date: "2027-06-19" });
    const declined = await recordBooking(venueSite, { act_name: "June No", preferred_date: "2027-06-20" });
    const removed = await recordBooking(venueSite, { act_name: "June Off", preferred_date: "2027-06-25" });
    await recordBooking(otherSite, { act_name: "Not Yours", preferred_date: "2027-06-05" });

    await approveBooking(db, venue.ctx, booked, { eventDate: "2027-06-04", startTime: "21:00" }, deps());
    await holdBooking(db, venue.ctx, held, { eventDate: "2027-06-12", startTime: "20:00" }, { now: NOW });
    await declineBooking(db, venue.ctx, declined, { now: NOW });
    await approveBooking(db, venue.ctx, removed, { eventDate: "2027-06-25", startTime: "" }, deps());
    await setBookingListed(db, venue.ctx, removed, false, { now: NOW });

    const entries = await bookingCalendar(db, venue.ctx, "2027-06");
    expect(entries.map((e) => [e.date, e.kind, e.actName, e.startTime])).toEqual([
      ["2027-06-04", "booked", "June Booked", "21:00"],
      ["2027-06-12", "held", "June Held", "20:00"],
      ["2027-06-19", "requested", "June Asked", null],
    ]);
    expect(entries.map((e) => e.leadPublicId)).toEqual([booked, held, expect.any(String)]);
  });

  it("drops a request for a night that has passed, but keeps a past show as it was", async () => {
    const asked = await recordBooking(venueSite, { act_name: "Missed It", preferred_date: "2026-11-02" });
    const played = await recordBooking(venueSite, { act_name: "Played It", preferred_date: "2026-11-03" });
    await approveBooking(db, venue.ctx, played, { eventDate: "2026-11-03", startTime: "" }, deps());
    expect(asked).toBeTruthy();

    const entries = await bookingCalendar(db, venue.ctx, "2026-11", { today: "2026-11-10" });
    const names = entries.map((e) => e.actName);
    expect(names).toContain("Played It");
    expect(names).not.toContain("Missed It");
  });

  it("is only shown to clients that take bookings", async () => {
    expect(await takesBookings(db, venue.ctx)).toBe(true);
    const plumber = await seedTenant(db, "Pipe Works");
    expect(await takesBookings(db, plumber.ctx)).toBe(false);
  });

  it("keeps an undecided request on the calendar after it is archived", async () => {
    const lead = await recordBooking(venueSite, { act_name: "July Asked", preferred_date: "2027-07-09" });
    await setLeadArchived(db, venue.ctx, lead, true);
    const entries = await bookingCalendar(db, venue.ctx, "2027-07");
    expect(entries).toEqual([
      { date: "2027-07-09", kind: "requested", actName: "July Asked", startTime: null, leadPublicId: lead },
    ]);
  });
});

describe("the inbox's line after a quick approve or decline", () => {
  // The row leaves the Open list as soon as it is decided, taking its buttons
  // with it, so the inbox says what happened from the stored decision.
  const booked = {
    decision: "approved" as const,
    actName: "The Late Shift",
    eventDate: "2026-11-14",
    startTime: "21:00",
    emailStatus: "sent" as const,
  };

  it("says an approved act was emailed and is on the events page", () => {
    expect(decisionNotice(booked)).toBe(
      "The Late Shift is booked for Saturday, November 14, 2026 · 9 PM. They were emailed, and the show is on your events page.",
    );
  });

  it("says plainly when the email to them did not go out", () => {
    expect(decisionNotice({ ...booked, startTime: null, emailStatus: "failed" })).toBe(
      "The Late Shift is booked for Saturday, November 14, 2026 and is on your events page, but the email to them didn't go through. Open the request to reply to them.",
    );
    expect(decisionNotice({ ...booked, emailStatus: "not_sent" })).toBe(
      "The Late Shift is booked for Saturday, November 14, 2026 · 9 PM and is on your events page. They weren't emailed.",
    );
  });

  it("does not claim a show taken off the site is still on it", () => {
    expect(decisionNotice({ ...booked, removed: true })).toBe(
      "The Late Shift was approved for Saturday, November 14, 2026 · 9 PM, then taken off your events page.",
    );
  });

  it("says a declined act was not emailed, from what was stored", async () => {
    const lead = await recordBooking(venueSite);
    await declineBooking(db, venue.ctx, lead, { now: NOW });
    const state = (await bookingStatesFor(db, venue.ctx, [lead])).get(lead)!;
    expect(decisionNotice(state)).toBe("You declined The Late Shift. They haven't been emailed.");
  });
});

describe("the public list of upcoming shows", () => {
  it("lists only approved, listed, future shows for this site, soonest first, with nothing private", async () => {
    const early = await recordBooking(venueSite, { act_name: "Early Bird" });
    const lateSameNight = await recordBooking(venueSite, { act_name: "Night Owl" });
    const untimedSameNight = await recordBooking(venueSite, { act_name: "Whenever" });
    const declined = await recordBooking(venueSite, { act_name: "Not Tonight" });
    const removed = await recordBooking(venueSite, { act_name: "Taken Down" });
    const elsewhere = await recordBooking(otherSite, { act_name: "Wrong Venue" });

    await approveBooking(db, venue.ctx, lateSameNight, { eventDate: "2027-01-09", startTime: "22:00" }, deps());
    await approveBooking(db, venue.ctx, untimedSameNight, { eventDate: "2027-01-09", startTime: "" }, deps());
    await approveBooking(db, venue.ctx, early, { eventDate: "2027-01-08", startTime: "20:00" }, deps());
    await declineBooking(db, venue.ctx, declined, { now: NOW });
    await approveBooking(db, venue.ctx, removed, { eventDate: "2027-01-10", startTime: "" }, deps());
    await setBookingListed(db, venue.ctx, removed, false, { now: NOW });
    await approveBooking(db, other.ctx, elsewhere, { eventDate: "2027-01-08", startTime: "" }, deps());

    // Other tests share this venue and list later shows of their own.
    const ours = new Set(["Early Bird", "Night Owl", "Whenever", "Not Tonight", "Taken Down", "Wrong Venue"]);
    const names = (list: Awaited<ReturnType<typeof listUpcomingEvents>>) =>
      list?.map((e) => e.actName).filter((name) => ours.has(name));

    const events = await listUpcomingEvents(db, venueSite.sitePublicId, "2027-01-01");
    expect(names(events)).toEqual(["Early Bird", "Night Owl", "Whenever"]);
    expect(JSON.stringify(events)).not.toContain("band.example");

    // A day later the first show has passed.
    const later = await listUpcomingEvents(db, venueSite.sitePublicId, "2027-01-09");
    expect(names(later)).toEqual(["Night Owl", "Whenever"]);
  });

  it("says the site does not exist rather than returning an empty list", async () => {
    expect(await listUpcomingEvents(db, newPublicId(), "2026-01-01")).toBeNull();
  });

  it("stops serving a logo once the show is taken off the site", async () => {
    const lead = await recordBooking(venueSite, { act_name: "Logo Test" });
    await approveBooking(db, venue.ctx, lead, { eventDate: "2027-02-01", startTime: "" }, deps());
    const [booking] = await db
      .select({ publicId: eventBookings.publicId })
      .from(eventBookings)
      .innerJoin(leads, eq(leads.id, eventBookings.leadId))
      .where(eq(leads.publicId, lead));

    expect(await findListedEventLogo(db, venueSite.sitePublicId, booking!.publicId)).not.toBeNull();
    await setBookingListed(db, venue.ctx, lead, false, { now: NOW });
    expect(await findListedEventLogo(db, venueSite.sitePublicId, booking!.publicId)).toBeNull();
  });
});

describe("the inbox's logo preview", () => {
  it("serves the stored copy once approved, without asking Netlify again", async () => {
    const lead = await recordBooking(venueSite, { act_name: "Preview Test" });
    await approveBooking(db, venue.ctx, lead, { eventDate: "2027-03-01", startTime: "" }, deps());
    const loadSubmission = vi.fn(async () => null);
    const logo = await readBookingLogo(db, venue.ctx, lead, deps({ loadSubmission }));
    expect(logo?.contentType).toBe("image/png");
    expect(loadSubmission).not.toHaveBeenCalled();
  });
});

describe("deleting a booking request's lead", () => {
  it("keeps an approved show on the site but forgets the performer's address", async () => {
    const lead = await recordBooking(venueSite, { act_name: "Forget Me" });
    await approveBooking(db, venue.ctx, lead, { eventDate: "2027-04-01", startTime: "" }, deps());
    await deleteLead(db, venue.ctx, lead);

    const [row] = await db
      .select({ contactEmail: eventBookings.contactEmail, decision: eventBookings.decision })
      .from(eventBookings)
      .where(eq(eventBookings.actName, "Forget Me"));
    expect(row).toEqual({ contactEmail: null, decision: "approved" });
  });

  it("removes a declined request entirely", async () => {
    const lead = await recordBooking(venueSite, { act_name: "Gone Entirely" });
    await declineBooking(db, venue.ctx, lead, { now: NOW });
    await deleteLead(db, venue.ctx, lead);
    const rows = await db.select().from(eventBookings).where(eq(eventBookings.actName, "Gone Entirely"));
    expect(rows).toHaveLength(0);
  });

  it("removes a held date from the calendar too — it was never public", async () => {
    const lead = await recordBooking(venueSite, { act_name: "Held Then Gone" });
    await holdBooking(db, venue.ctx, lead, { eventDate: "2027-08-06", startTime: "" }, { now: NOW });
    await deleteLead(db, venue.ctx, lead);
    const rows = await db.select().from(eventBookings).where(eq(eventBookings.actName, "Held Then Gone"));
    expect(rows).toHaveLength(0);
  });
});
