import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  businessProfiles,
  clients,
  leads,
  reviewRequests,
  reviewSettings,
  reviewSuppressions,
  sites,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import type { EmailMessage, SendResult } from "@/lib/email/mailer";
import type { SmsResult } from "@/lib/reviews/sms";
import { signReviewToken } from "@/lib/reviews/tokens";
import { DEFAULT_TEMPLATE } from "@/lib/reviews/template";
import {
  addReviewSuppression,
  getReviewSetup,
  listLeadsForReview,
  listReviewRequests,
  listReviewSuppressions,
  removeReviewSuppression,
  reviewSummary,
  saveReviewLink,
  saveReviewMessage,
} from "@/db/repositories/client/reviews";
import { sendReviewRequest } from "@/db/repositories/client/review-send";
import {
  describeReviewStop,
  getClientReviews,
  recordReviewClick,
  runReviewReminders,
  unsubscribeReviewRequest,
} from "@/db/repositories/admin/reviews";
import { adminContextFrom, AuthorizationError, NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * Review requests, end to end below the UI.
 *
 * What would go wrong quietly: a customer who unsubscribed getting the
 * reminder anyway; a second reminder; a text sent without recorded consent;
 * the same customer asked twice in a week because the client pressed send
 * again; a click on one business's link counted for another; and a client
 * reading or sending from another client's records.
 */

const PLACE = "ChIJN1t_tDeuEmsRUsoyG83frY4";
const ENV = {
  AUTH_SECRET: "s".repeat(32),
  AUTH_URL: "https://portal.example",
  RESEND_FROM_ADDRESS: '"Mortensen Web Co." <hello@mortensenweb.example>',
};
const SENT_AT = new Date("2026-10-17T18:00:00Z"); // noon in Denver
const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let globex: SeededTenant;

const outbox: EmailMessage[] = [];
const texts: { to: string; body: string }[] = [];
const delivered = async (message: EmailMessage): Promise<SendResult> => {
  outbox.push(message);
  return { status: "sent", id: `re_${outbox.length}` };
};
const texted = async (message: { to: string; body: string }): Promise<SmsResult> => {
  texts.push(message);
  return { status: "sent", id: `SM${texts.length}` };
};

function deps(overrides: Record<string, unknown> = {}) {
  return { send: delivered, text: texted, smsEnabled: false, now: SENT_AT, env: ENV, ...overrides };
}

async function send(tenant: SeededTenant, input: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return sendReviewRequest(db, tenant.ctx, { name: "Dana Reyes", ...input }, deps(overrides));
}

async function addLead(tenant: SeededTenant, values: Partial<typeof leads.$inferInsert> = {}) {
  const [site] = await db
    .insert(sites)
    .values({ publicId: newPublicId(), organizationId: tenant.organizationId, name: "site" })
    .returning({ id: sites.id });
  const publicId = newPublicId();
  await db.insert(leads).values({
    publicId,
    organizationId: tenant.organizationId,
    siteId: site!.id,
    providerSubmissionId: newPublicId(),
    name: "Sam Ortiz",
    email: "Sam@Example.test",
    phone: "(801) 555-0199",
    receivedAt: new Date("2026-10-01T15:00:00Z"),
    ...values,
  });
  return publicId;
}

function linkIn(message: EmailMessage, path: RegExp): string {
  const match = message.text.match(path);
  expect(match, `no ${path} in the email`).not.toBeNull();
  return match![1]!;
}

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  acme = await seedTenant(db, "Acme Plumbing");
  globex = await seedTenant(db, "Globex");
  await db.insert(businessProfiles).values({
    organizationId: acme.organizationId,
    details: {
      businessName: "Acme Plumbing & Heating",
      email: "office@acme.example",
      address: "12 Main St, Riverton, UT",
    },
  });
});

afterAll(async () => close());

beforeEach(async () => {
  outbox.length = 0;
  texts.length = 0;
  await db.delete(reviewSuppressions);
  await db.delete(reviewRequests);
  await db.delete(reviewSettings);
  await saveReviewLink(db, acme.ctx, { input: PLACE }, { lookup: null });
});

describe("setup", () => {
  it("saves the review link built from a place id", async () => {
    const setup = await getReviewSetup(db, acme.ctx);
    expect(setup?.reviewUrl).toBe(`https://search.google.com/local/writereview?placeid=${PLACE}`);
    expect(setup?.placeId).toBe(PLACE);
    expect(setup?.reminderDays).toBe(3);
    expect(setup?.template).toEqual(DEFAULT_TEMPLATE);
  });

  it("refuses a link that is not a Google review link", async () => {
    const result = await saveReviewLink(db, acme.ctx, { input: "https://evil.example/x" }, { lookup: null });
    expect(result.ok).toBe(false);
    expect((await getReviewSetup(db, acme.ctx))?.placeId).toBe(PLACE);
  });

  it("checks a place id with Google when it can, and refuses one Google does not know", async () => {
    const unknown = vi.fn(async () => ({ ok: false as const, reason: "not_found" as const }));
    const refused = await saveReviewLink(db, acme.ctx, { input: "ChIJunknownplace12345" }, { lookup: unknown });
    expect(refused).toEqual({ ok: false, message: expect.stringMatching(/Google/) });

    const known = vi.fn(async () => ({
      ok: true as const,
      place: { placeId: "ChIJknownplace1234567", name: "Acme Plumbing", rating: 4.8, reviewCount: 112 },
    }));
    expect((await saveReviewLink(db, acme.ctx, { input: "ChIJknownplace1234567" }, { lookup: known })).ok).toBe(true);
    expect((await getReviewSetup(db, acme.ctx))?.placeName).toBe("Acme Plumbing");
  });

  it("keeps a business's own words, and refuses a gated message", async () => {
    const saved = await saveReviewMessage(db, acme.ctx, {
      ...DEFAULT_TEMPLATE,
      body: "Hi {first_name}, thanks for having us out. An honest review helps. {business}",
      reminderDays: 5,
      remindersEnabled: true,
    });
    expect(saved.ok).toBe(true);
    const setup = await getReviewSetup(db, acme.ctx);
    expect(setup?.template.body).toContain("thanks for having us out");
    expect(setup?.reminderDays).toBe(5);

    const gated = await saveReviewMessage(db, acme.ctx, {
      ...DEFAULT_TEMPLATE,
      body: "If you were happy with us, please leave a review!",
      reminderDays: 3,
      remindersEnabled: true,
    });
    expect(gated.ok).toBe(false);
  });

  it("stores an unchanged default as the default, so a better default reaches them later", async () => {
    await saveReviewMessage(db, acme.ctx, { ...DEFAULT_TEMPLATE, reminderDays: 3, remindersEnabled: true });
    const [row] = await db.select().from(reviewSettings).where(eq(reviewSettings.organizationId, acme.organizationId));
    expect(row!.emailBody).toBeNull();
    expect(row!.emailSubject).toBeNull();
  });

  it("is read-only while an operator views as the client", async () => {
    const viewing = tenantContextFrom(
      { userId: acme.userId, organizationId: acme.organizationId, role: "admin", status: "active", sessionEpoch: 0 },
      acme.organizationId,
      { impersonating: true },
    );
    await expect(saveReviewLink(db, viewing, { input: PLACE }, { lookup: null })).rejects.toThrow(AuthorizationError);
    await expect(sendReviewRequest(db, viewing, { name: "Dana", email: "d@example.test" }, deps())).rejects.toThrow(
      AuthorizationError,
    );
  });
});

describe("sending a request", () => {
  it("emails the customer a tracked link, in the business's name, and schedules one reminder", async () => {
    const result = await send(acme, { email: "Dana@Example.test" });
    expect(result).toMatchObject({ ok: true, emailStatus: "sent", smsStatus: null });

    expect(outbox).toHaveLength(1);
    const email = outbox[0]!;
    expect(email.to).toBe("dana@example.test");
    expect(email.from).toBe('"Acme Plumbing & Heating" <hello@mortensenweb.example>');
    expect(email.replyTo).toBe("office@acme.example");
    expect(email.text).toContain("Hi Dana,");
    expect(email.text).toContain("12 Main St, Riverton, UT");
    expect(linkIn(email, /(https:\/\/portal\.example\/review\/[^\s/]+)\n/)).toMatch(/\/review\/[0-9A-Z]{26}\./);
    expect(email.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/portal\.example\/review\/.+\/unsubscribe>$/);

    const [row] = await db.select().from(reviewRequests);
    expect(row!.sentAt).toEqual(SENT_AT);
    expect(row!.reminderDueAt).toEqual(new Date(SENT_AT.getTime() + THREE_DAYS));
    expect(row!.fromName).toBe("Acme Plumbing & Heating");
  });

  it("refuses before setup, without sending anything", async () => {
    const result = await send(globex, { email: "dana@example.test" });
    expect(result).toEqual({ ok: false, message: expect.stringMatching(/review link/) });
    expect(outbox).toHaveLength(0);
  });

  it("needs a name and somewhere to send it", async () => {
    expect((await send(acme, { name: " ", email: "dana@example.test" })).ok).toBe(false);
    expect((await send(acme, { email: "not-an-email" })).ok).toBe(false);
    expect((await send(acme, {})).ok).toBe(false);
    expect(outbox).toHaveLength(0);
  });

  it("does not ask someone who unsubscribed", async () => {
    await addReviewSuppression(db, acme.ctx, "dana@example.test");
    const result = await send(acme, { email: "DANA@example.test" });
    expect(result).toEqual({ ok: false, message: expect.stringMatching(/asked not to/) });
    expect(outbox).toHaveLength(0);
  });

  it("does not ask the same customer twice within thirty days", async () => {
    await send(acme, { email: "dana@example.test" });
    const again = await send(acme, { email: "dana@example.test" }, { now: new Date(SENT_AT.getTime() + 86_400_000) });
    expect(again).toEqual({ ok: false, message: expect.stringMatching(/already asked/) });
    expect(outbox).toHaveLength(1);

    const later = await send(acme, { email: "dana@example.test" }, { now: new Date(SENT_AT.getTime() + 31 * 86_400_000) });
    expect(later.ok).toBe(true);
  });

  it("records a failed email, and schedules no reminder for it", async () => {
    const failing = async (): Promise<SendResult> => ({ status: "failed", error: "Resend responded 500" });
    const result = await send(acme, { email: "dana@example.test" }, { send: failing });
    expect(result.ok).toBe(false);
    const [row] = await db.select().from(reviewRequests);
    expect(row!.emailStatus).toBe("failed");
    expect(row!.sentAt).toBeNull();
    expect(row!.reminderDueAt).toBeNull();
  });

  it("records an email that was not sent because sending is off here, and says so", async () => {
    const skipped = async (): Promise<SendResult> => ({ status: "skipped", reason: "no_api_key" });
    const result = await send(acme, { email: "dana@example.test" }, { send: skipped });
    expect(result).toMatchObject({ ok: true, emailStatus: "not_sent" });
    const [row] = await db.select().from(reviewRequests);
    expect(row!.reminderDueAt).toBeNull();
  });

  it("schedules no reminder when the business switched reminders off", async () => {
    await saveReviewMessage(db, acme.ctx, { ...DEFAULT_TEMPLATE, reminderDays: 3, remindersEnabled: false });
    await send(acme, { email: "dana@example.test" });
    const [row] = await db.select().from(reviewRequests);
    expect(row!.reminderDueAt).toBeNull();
  });

  it("fills the customer in from a lead in the business's own inbox", async () => {
    const lead = await addLead(acme);
    const result = await send(acme, { name: "", leadPublicId: lead });
    expect(result.ok).toBe(true);
    expect(outbox[0]!.to).toBe("sam@example.test");
    expect(outbox[0]!.text).toContain("Hi Sam,");
    const [row] = await db.select().from(reviewRequests);
    expect(row!.leadId).not.toBeNull();
  });

  it("will not read another business's lead", async () => {
    const theirs = await addLead(globex);
    await expect(send(acme, { name: "", leadPublicId: theirs })).rejects.toThrow(NotFoundError);
  });
});

describe("texting", () => {
  it("is not offered when SMS is not set up, even with consent", async () => {
    const result = await send(acme, { phone: "801-555-0123", smsConsent: true });
    expect(result).toEqual({ ok: false, message: expect.stringMatching(/email/) });
    expect(texts).toHaveLength(0);
  });

  it("needs the customer's recorded consent", async () => {
    const result = await send(acme, { phone: "801-555-0123", smsConsent: false }, { smsEnabled: true });
    expect(result).toEqual({ ok: false, message: expect.stringMatching(/agreed/) });
    expect(texts).toHaveLength(0);
  });

  it("texts with consent, recording who confirmed it and when", async () => {
    const result = await send(acme, { phone: "801-555-0123", smsConsent: true }, { smsEnabled: true });
    expect(result).toMatchObject({ ok: true, smsStatus: "sent", emailStatus: null });
    expect(texts[0]!.to).toBe("+18015550123");
    expect(texts[0]!.body).toMatch(/^Acme Plumbing & Heating: Hi Dana/);
    expect(texts[0]!.body).toContain("https://portal.example/review/");
    const [row] = await db.select().from(reviewRequests);
    expect(row!.smsConsentAt).toEqual(SENT_AT);
    expect(row!.smsConsentBy).toBe(acme.userId);
  });

  it("emails only, when there is an email and no consent to text", async () => {
    const result = await send(acme, { email: "dana@example.test", phone: "801-555-0123" }, { smsEnabled: true });
    expect(result).toMatchObject({ ok: true, emailStatus: "sent", smsStatus: null });
    expect(texts).toHaveLength(0);
  });

  it("adds a number that replied STOP to the suppression list", async () => {
    const stopped = async (): Promise<SmsResult> => ({ status: "opted_out" });
    await send(acme, { phone: "801-555-0123", smsConsent: true }, { smsEnabled: true, text: stopped });
    const list = await listReviewSuppressions(db, acme.ctx);
    expect(list).toEqual([expect.objectContaining({ channel: "sms", address: "+18015550123", reason: "sms_opt_out" })]);
  });
});

describe("the tracked link", () => {
  it("records the click and sends the customer to the business's Google review form", async () => {
    await send(acme, { email: "dana@example.test" });
    const [row] = await db.select().from(reviewRequests);
    const clickedAt = new Date(SENT_AT.getTime() + 60_000);

    expect(await recordReviewClick(db, row!.publicId, clickedAt)).toBe(
      `https://search.google.com/local/writereview?placeid=${PLACE}`,
    );
    const [after] = await db.select().from(reviewRequests);
    expect(after!.firstClickedAt).toEqual(clickedAt);
    expect(after!.clickCount).toBe(1);
  });

  it("does not count a burst of reloads as more clicks", async () => {
    await send(acme, { email: "dana@example.test" });
    const [row] = await db.select().from(reviewRequests);
    const t = SENT_AT.getTime() + 60_000;
    await recordReviewClick(db, row!.publicId, new Date(t));
    await recordReviewClick(db, row!.publicId, new Date(t + 2_000));
    await recordReviewClick(db, row!.publicId, new Date(t + 60_000));
    const [after] = await db.select().from(reviewRequests);
    expect(after!.clickCount).toBe(2);
    expect(after!.firstClickedAt).toEqual(new Date(t));
  });

  it("knows nothing about a request that does not exist", async () => {
    expect(await recordReviewClick(db, newPublicId(), SENT_AT)).toBeNull();
  });
});

describe("unsubscribing", () => {
  it("suppresses every way the business could reach them, and is idempotent", async () => {
    await send(acme, { email: "dana@example.test", phone: "801-555-0123", smsConsent: true }, { smsEnabled: true });
    const [row] = await db.select().from(reviewRequests);

    expect(await describeReviewStop(db, row!.publicId)).toEqual({
      businessName: "Acme Plumbing & Heating",
      unsubscribed: false,
    });
    expect(await unsubscribeReviewRequest(db, row!.publicId, SENT_AT)).toEqual({ businessName: "Acme Plumbing & Heating" });
    expect(await unsubscribeReviewRequest(db, row!.publicId, SENT_AT)).toEqual({ businessName: "Acme Plumbing & Heating" });

    const list = await listReviewSuppressions(db, acme.ctx);
    expect(list.map((s) => [s.channel, s.address, s.reason]).sort()).toEqual([
      ["email", "dana@example.test", "unsubscribed"],
      ["sms", "+18015550123", "unsubscribed"],
    ]);
    expect((await describeReviewStop(db, row!.publicId))?.unsubscribed).toBe(true);
    // Only this business's list.
    expect(await listReviewSuppressions(db, globex.ctx)).toEqual([]);
  });

  it("leaves a customer's own unsubscribe for them alone to undo", async () => {
    await send(acme, { email: "dana@example.test" });
    const [row] = await db.select().from(reviewRequests);
    await unsubscribeReviewRequest(db, row!.publicId, SENT_AT);

    expect((await removeReviewSuppression(db, acme.ctx, "email", "dana@example.test")).ok).toBe(false);
    expect(await listReviewSuppressions(db, acme.ctx)).toHaveLength(1);

    await addReviewSuppression(db, acme.ctx, "(801) 555-0100");
    expect((await removeReviewSuppression(db, acme.ctx, "sms", "+18015550100")).ok).toBe(true);
  });
});

describe("the reminder", () => {
  const due = new Date(SENT_AT.getTime() + THREE_DAYS);

  it("goes once, to a customer who has not clicked, using the reminder wording", async () => {
    await send(acme, { email: "dana@example.test" });
    outbox.length = 0;

    const first = await runReviewReminders(db, deps({ now: due }));
    expect(first).toMatchObject({ sent: 1 });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.text).toContain("Just a reminder");
    expect(outbox[0]!.text).toContain("https://portal.example/review/");

    const second = await runReviewReminders(db, deps({ now: new Date(due.getTime() + THREE_DAYS) }));
    expect(second).toMatchObject({ sent: 0 });
    expect(outbox).toHaveLength(1);

    const [row] = await db.select().from(reviewRequests);
    expect(row!.reminderStatus).toBe("sent");
    expect(row!.remindedAt).toEqual(due);
  });

  it("is never sent twice by two overlapping runs", async () => {
    await send(acme, { email: "dana@example.test" });
    outbox.length = 0;
    const results = await Promise.all([runReviewReminders(db, deps({ now: due })), runReviewReminders(db, deps({ now: due }))]);
    expect(results.reduce((n, r) => n + ("sent" in r ? r.sent : 0), 0)).toBe(1);
    expect(outbox).toHaveLength(1);
  });

  it("is not sent before it is due, or after the customer clicked", async () => {
    await send(acme, { email: "dana@example.test" });
    outbox.length = 0;
    expect(await runReviewReminders(db, deps({ now: new Date(due.getTime() - 60_000) }))).toMatchObject({ sent: 0 });

    const [row] = await db.select().from(reviewRequests);
    await recordReviewClick(db, row!.publicId, new Date(SENT_AT.getTime() + 60_000));
    expect(await runReviewReminders(db, deps({ now: due }))).toMatchObject({ sent: 0 });
    expect(outbox).toHaveLength(0);
  });

  it("is not sent to someone who unsubscribed after the first email", async () => {
    await send(acme, { email: "dana@example.test" });
    outbox.length = 0;
    const [row] = await db.select().from(reviewRequests);
    await unsubscribeReviewRequest(db, row!.publicId, new Date(SENT_AT.getTime() + 60_000));

    await runReviewReminders(db, deps({ now: due }));
    expect(outbox).toHaveLength(0);
  });

  it("is not sent to an address the business added to its list after sending", async () => {
    await send(acme, { email: "dana@example.test" });
    outbox.length = 0;
    await addReviewSuppression(db, acme.ctx, "dana@example.test");

    expect(await runReviewReminders(db, deps({ now: due }))).toMatchObject({ sent: 0, suppressed: 1 });
    expect(outbox).toHaveLength(0);
    const [row] = await db.select().from(reviewRequests);
    expect(row!.reminderStatus).toBe("suppressed");
  });

  it("waits for daytime where the business is", async () => {
    await send(acme, { email: "dana@example.test" });
    outbox.length = 0;
    const night = new Date("2026-10-21T08:00:00Z"); // 2am in Denver, and past due
    expect(await runReviewReminders(db, deps({ now: night }))).toEqual({ skipped: "outside sending hours" });
    expect(outbox).toHaveLength(0);
  });

  it("is cancelled, not sent, when the business switched reminders off after sending", async () => {
    await send(acme, { email: "dana@example.test" });
    outbox.length = 0;
    await saveReviewMessage(db, acme.ctx, { ...DEFAULT_TEMPLATE, reminderDays: 3, remindersEnabled: false });

    expect(await runReviewReminders(db, deps({ now: due }))).toMatchObject({ sent: 0, cancelled: 1 });
    expect(outbox).toHaveLength(0);
    const [row] = await db.select().from(reviewRequests);
    expect(row!.reminderDueAt).toBeNull();
    expect(row!.remindedAt).toBeNull();
  });

  it("texts the reminder only to someone who agreed to texts", async () => {
    await send(acme, { phone: "801-555-0123", smsConsent: true }, { smsEnabled: true });
    texts.length = 0;
    await runReviewReminders(db, deps({ now: due, smsEnabled: true }));
    expect(texts).toHaveLength(1);
    expect(texts[0]!.body).toContain("reminder");
  });
});

describe("the dashboard's view", () => {
  it("shows sent, clicked and reminded per request, and the click rate", async () => {
    await send(acme, { name: "Dana Reyes", email: "dana@example.test" });
    await send(acme, { name: "Sam Ortiz", email: "sam@example.test" });
    await send(acme, { name: "Lee Park", email: "lee@example.test" }, { send: async () => ({ status: "failed", error: "x" }) as SendResult });
    const rows = await db.select().from(reviewRequests);
    const dana = rows.find((r) => r.customerName === "Dana Reyes")!;
    await recordReviewClick(db, dana.publicId, new Date(SENT_AT.getTime() + 60_000));
    await runReviewReminders(db, deps({ now: new Date(SENT_AT.getTime() + THREE_DAYS) }));

    expect(await reviewSummary(db, acme.ctx)).toEqual({ sent: 2, clicked: 1, reminded: 1, clickRate: 0.5 });

    const { requests } = await listReviewRequests(db, acme.ctx);
    expect(requests).toHaveLength(3);
    const byName = Object.fromEntries(requests.map((r) => [r.customerName, r]));
    expect(byName["Dana Reyes"]!.clickedAt).not.toBeNull();
    expect(byName["Sam Ortiz"]!.remindedAt).not.toBeNull();
    expect(byName["Lee Park"]!.sentAt).toBeNull();
    expect(byName["Lee Park"]!.emailStatus).toBe("failed");
  });

  it("gives no click rate, rather than 0%, before anything has been sent", async () => {
    expect(await reviewSummary(db, acme.ctx)).toEqual({ sent: 0, clicked: 0, reminded: 0, clickRate: null });
  });

  it("shows a business only its own requests and leads", async () => {
    await send(acme, { email: "dana@example.test" });
    const mine = await addLead(acme);
    expect((await listReviewRequests(db, globex.ctx)).requests).toEqual([]);
    expect(await reviewSummary(db, globex.ctx)).toMatchObject({ sent: 0 });
    expect((await listLeadsForReview(db, globex.ctx)).map((l) => l.publicId)).not.toContain(mine);
    expect((await listLeadsForReview(db, acme.ctx)).map((l) => l.publicId)).toContain(mine);
  });

  it("uses the business's own token for each link", async () => {
    await send(acme, { email: "dana@example.test" });
    const [row] = await db.select().from(reviewRequests);
    const expected = await signReviewToken(row!.publicId, "click", ENV);
    expect(outbox[0]!.text).toContain(`https://portal.example/review/${expected}`);
  });
});

describe("the operator's view", () => {
  const admin = adminContextFrom({ userId: "00000000-0000-0000-0000-000000000000", organizationId: null, role: "admin", status: "active", sessionEpoch: 0 });

  it("shows one client's setup, totals and recent requests", async () => {
    await send(acme, { email: "dana@example.test" });
    await addReviewSuppression(db, acme.ctx, "sam@example.test");
    const [client] = await db.select({ publicId: clients.publicId }).from(clients).where(eq(clients.id, acme.clientId));

    const view = await getClientReviews(admin, db, client!.publicId);
    expect(view.setup?.placeId).toBe(PLACE);
    expect(view).toMatchObject({ sent: 1, clicked: 0, reminded: 0, suppressed: 1 });
    expect(view.recent.map((r) => r.customerName)).toEqual(["Dana Reyes"]);
  });

  it("says a client has not set up rather than showing empty totals as a setup", async () => {
    const [client] = await db.select({ publicId: clients.publicId }).from(clients).where(eq(clients.id, globex.clientId));
    expect((await getClientReviews(admin, db, client!.publicId)).setup).toBeNull();
  });

  it("treats an unknown client as not found", async () => {
    await expect(getClientReviews(admin, db, newPublicId())).rejects.toThrow(NotFoundError);
  });
});
