import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db/client";
import { reviewRequests, reviewSettings, reviewSuppressions } from "@/db/schema";
import type { EmailMessage, SendResult } from "@/lib/email/mailer";
import { svixSignatureFor, type ResendEvent } from "@/lib/email/resend-webhook";
import { featureTags, readTags } from "@/lib/email/tags";
import type { SmsResult } from "@/lib/reviews/sms";
import { listReviewSuppressions, saveReviewLink } from "@/db/repositories/client/reviews";
import { sendReviewRequest } from "@/db/repositories/client/review-send";
import { applyReviewDeliveryEvent, runReviewReminders, unsubscribeReviewRequest } from "@/db/repositories/admin/reviews";
import { DELIVERY_EVENT_HANDLERS, routeDeliveryEvent } from "@/db/repositories/admin/delivery-events";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * Review requests hearing back from Resend: a hard bounce or a spam complaint
 * puts the address on that business's list.
 *
 * What would go wrong quietly: the reminder going to an address that already
 * bounced or reported the first email as spam (each one costs every business
 * sending through us some deliverability); a bounce on one business's email
 * suppressing the address for another; a retried delivery failing on the
 * unique key, so Resend retries forever; and a soft bounce suppressing a
 * customer whose mailbox was only full.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let globex: SeededTenant;

vi.mock("@/db/client", () => ({ getDb: async () => db }));

const PLACE = "ChIJN1t_tDeuEmsRUsoyG83frY4";
const ENV = {
  AUTH_SECRET: "s".repeat(32),
  AUTH_URL: "https://portal.example",
  RESEND_FROM_ADDRESS: '"Mortensen Web Co." <hello@mortensenweb.example>',
};
const SENT_AT = new Date("2026-10-17T18:00:00Z"); // noon in Denver
const DUE = new Date(SENT_AT.getTime() + 3 * 24 * 60 * 60 * 1000);
const NEXT_MONTH = new Date(SENT_AT.getTime() + 31 * 24 * 60 * 60 * 1000);
const WEBHOOK_SECRET = `whsec_${btoa("0123456789abcdef0123456789abcdef")}`;

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

async function ask(tenant: SeededTenant, input: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return sendReviewRequest(db, tenant.ctx, { name: "Dana Reyes", email: "dana@example.test", ...input }, deps(overrides));
}

/** What Resend would send back about the last email: the tags exactly as they were set. */
function eventFor(message: EmailMessage, type: ResendEvent["type"], extra: Partial<ResendEvent> = {}): ResendEvent {
  return { type, emailId: "re_1", to: [message.to], tags: readTags(message.tags), at: new Date(SENT_AT.getTime() + 60_000), ...extra };
}

async function suppressions() {
  return db.select().from(reviewSuppressions);
}

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  acme = await seedTenant(db, "Acme Plumbing");
  globex = await seedTenant(db, "Globex");
});

afterAll(async () => close());

beforeEach(async () => {
  outbox.length = 0;
  texts.length = 0;
  vi.unstubAllEnvs();
  await db.delete(reviewSuppressions);
  await db.delete(reviewRequests);
  await db.delete(reviewSettings);
  await saveReviewLink(db, acme.ctx, { input: PLACE }, { lookup: null });
  await saveReviewLink(db, globex.ctx, { input: PLACE }, { lookup: null });
});

describe("tagging", () => {
  it("tags the request and its reminder with the feature, the business and the request", async () => {
    const sent = await ask(acme);
    expect(sent.ok).toBe(true);
    const publicId = sent.ok ? sent.publicId : "";
    const expected = featureTags("reviews", acme.organizationId, { review_request: publicId });
    expect(outbox[0]!.tags).toEqual(expected);

    await runReviewReminders(db, deps({ now: DUE }));
    expect(outbox).toHaveLength(2);
    expect(outbox[1]!.tags).toEqual(expected);
  });

  it("is what the webhook routes to review requests", () => {
    expect(applyReviewDeliveryEvent).toBeTypeOf("function");
    expect(DELIVERY_EVENT_HANDLERS.reviews).toBe(applyReviewDeliveryEvent);
  });
});

describe("a hard bounce or a spam complaint", () => {
  it("suppresses a bounced address for that business, so the reminder does not go", async () => {
    await ask(acme);
    expect(await routeDeliveryEvent(db, eventFor(outbox[0]!, "bounced", { bounceType: "Permanent" }))).toBe("handled");

    const list = await listReviewSuppressions(db, acme.ctx);
    expect(list).toEqual([expect.objectContaining({ channel: "email", address: "dana@example.test", reason: "bounced" })]);
    expect(await listReviewSuppressions(db, globex.ctx)).toEqual([]);

    expect(await runReviewReminders(db, deps({ now: DUE }))).toMatchObject({ sent: 0, suppressed: 1 });
    expect(outbox).toHaveLength(1);
  });

  it("suppresses an address whose owner marked the email as spam", async () => {
    await ask(acme);
    await routeDeliveryEvent(db, eventFor(outbox[0]!, "complained"));
    expect(await listReviewSuppressions(db, acme.ctx)).toEqual([
      expect.objectContaining({ channel: "email", address: "dana@example.test", reason: "complained" }),
    ]);
  });

  it("counts a bounce on the reminder the same as one on the request", async () => {
    await ask(acme);
    await runReviewReminders(db, deps({ now: DUE }));
    await routeDeliveryEvent(db, eventFor(outbox[1]!, "bounced"));
    expect(await listReviewSuppressions(db, acme.ctx)).toEqual([expect.objectContaining({ reason: "bounced" })]);
  });

  it("refuses a later request to a bounced address, and says it bounced", async () => {
    await ask(acme);
    await routeDeliveryEvent(db, eventFor(outbox[0]!, "bounced"));

    const again = await ask(acme, {}, { now: NEXT_MONTH });
    expect(again).toEqual({ ok: false, message: "Email to dana@example.test bounced before. Check the address with Dana." });
    expect(outbox).toHaveLength(1);
  });

  it("stops only the email: a customer who agreed to texts still gets the reminder by text", async () => {
    await ask(acme, { phone: "801-555-0123", smsConsent: true }, { smsEnabled: true });
    await routeDeliveryEvent(db, eventFor(outbox[0]!, "bounced"));

    expect(await runReviewReminders(db, deps({ now: DUE, smsEnabled: true }))).toMatchObject({ sent: 1 });
    expect(outbox).toHaveLength(1);
    expect(texts).toHaveLength(2);
  });

  it("is idempotent, and an address already on the list keeps its first reason", async () => {
    await ask(acme);
    const bounce = eventFor(outbox[0]!, "bounced");
    await applyReviewDeliveryEvent(db, bounce);
    await applyReviewDeliveryEvent(db, bounce);
    await applyReviewDeliveryEvent(db, eventFor(outbox[0]!, "complained"));
    expect(await suppressions()).toEqual([expect.objectContaining({ reason: "bounced" })]);
  });

  it("leaves a customer's own unsubscribe as it was", async () => {
    const sent = await ask(acme);
    await unsubscribeReviewRequest(db, sent.ok ? sent.publicId : "", new Date(SENT_AT.getTime() + 30_000));
    await applyReviewDeliveryEvent(db, eventFor(outbox[0]!, "complained"));
    expect(await suppressions()).toEqual([expect.objectContaining({ channel: "email", reason: "unsubscribed" })]);
  });
});

describe("what it leaves alone", () => {
  it("an event whose organization tag names another business", async () => {
    await ask(acme);
    const event = eventFor(outbox[0]!, "bounced");
    await applyReviewDeliveryEvent(db, { ...event, tags: { ...event.tags, organization: globex.organizationId } });
    const { organization: _organization, ...untagged } = event.tags;
    await applyReviewDeliveryEvent(db, { ...event, tags: untagged });
    expect(await suppressions()).toEqual([]);
  });

  it("a temporary bounce, and deliveries, opens and clicks", async () => {
    await ask(acme);
    await applyReviewDeliveryEvent(db, eventFor(outbox[0]!, "bounced", { bounceType: "Temporary" }));
    for (const type of ["delivered", "opened", "clicked"] as const) {
      await applyReviewDeliveryEvent(db, eventFor(outbox[0]!, type));
    }
    expect(await suppressions()).toEqual([]);
  });

  it("an event for a request that does not exist", async () => {
    const tags = featureTags("reviews", acme.organizationId, { review_request: "01HNOSUCHREQUEST000000000A" });
    await expect(
      applyReviewDeliveryEvent(db, { type: "bounced", emailId: "re_x", to: ["x@example.test"], tags: readTags(tags), at: SENT_AT }),
    ).resolves.toBeUndefined();
    expect(await suppressions()).toEqual([]);
  });
});

describe("through the webhook", () => {
  it("suppresses the address when Resend reports a bounce", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", WEBHOOK_SECRET);
    await ask(acme);
    const body = JSON.stringify({
      type: "email.bounced",
      created_at: new Date().toISOString(),
      data: {
        email_id: "re_1",
        to: ["dana@example.test"],
        tags: outbox[0]!.tags,
        bounce: { type: "Permanent", subType: "General", message: "The recipient's mail server rejected the email." },
      },
    });
    const id = "msg_1";
    const ts = String(Math.floor(Date.now() / 1000));
    const { POST } = await import("@/app/api/webhooks/resend/route");
    const response = await POST(
      new Request("https://portal.example/api/webhooks/resend", {
        method: "POST",
        headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": await svixSignatureFor(id, ts, body, WEBHOOK_SECRET) },
        body,
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, outcome: "handled" });
    expect(await suppressions()).toEqual([expect.objectContaining({ address: "dana@example.test", reason: "bounced" })]);
  });
});
