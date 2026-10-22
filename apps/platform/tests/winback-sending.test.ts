import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  businessProfiles,
  clientAddOns,
  users,
  winbackCampaigns,
  winbackContacts,
  winbackRecipients,
  winbackSuppressions,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import type { EmailMessage, SendResult } from "@/lib/email/mailer";
import { approveCampaign, createDraft, getCampaign } from "@/db/repositories/client/winback-campaigns";
import { runWinbackSends } from "@/db/repositories/admin/winback-sender";
import {
  describeUnsubscribe,
  haltAllWinback,
  haltCampaign,
  listWinbackCampaigns,
  unsubscribeRecipient,
  UNSUBSCRIBES_PER_IP_PER_HOUR,
} from "@/db/repositories/admin/winback";
import { DELIVERY_EVENT_HANDLERS, routeDeliveryEvent } from "@/db/repositories/admin/delivery-events";
import { adminContextFrom, type AdminContext } from "@/db/repositories/context";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * Sending win-back campaigns, and everything that happens after.
 *
 * What would go wrong quietly: a customer emailed twice because a run was
 * retried; an unsubscribed customer emailed by the next campaign; a kill
 * switch that stops the button but not the batch already running; a bounce
 * that never reaches the suppression list; and a rate limit read as a failure
 * that gives up on half a campaign.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let admin: AdminContext;
const NOW = new Date("2026-10-20T16:00:00Z");
const text = { name: "Fall", subject: "Hello", body: "Hi {first_name},\n\nIt's been a while.", offer: "", offerExpiresOn: "" };

let outbox: EmailMessage[] = [];
let nextResult: (m: EmailMessage) => SendResult = () => ({ status: "sent", id: `re_${outbox.length}` });
const send = async (message: EmailMessage): Promise<SendResult> => {
  outbox.push(message);
  return nextResult(message);
};
const noSleep = async () => {};

async function addContacts(tenant: SeededTenant, emails: string[]) {
  await db.insert(winbackContacts).values(
    emails.map((email, i) => ({
      publicId: newPublicId(),
      organizationId: tenant.organizationId,
      email,
      name: i === 0 ? "Dana Reyes" : null,
      source: "import",
      howBecameCustomer: "Imported",
    })),
  );
}

async function approvedCampaign(tenant: SeededTenant): Promise<string> {
  const publicId = await createDraft(db, tenant.ctx, "check-in");
  const result = await approveCampaign(db, tenant.ctx, publicId, { ...text, scheduleDay: "" }, NOW);
  if (!result.ok) throw new Error(result.message);
  return publicId;
}

async function recipients(campaignPublicId: string) {
  const [c] = await db.select({ id: winbackCampaigns.id }).from(winbackCampaigns).where(eq(winbackCampaigns.publicId, campaignPublicId));
  return db.select().from(winbackRecipients).where(eq(winbackRecipients.campaignId, c!.id));
}

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  const [adminUser] = await db
    .insert(users)
    .values({ publicId: newPublicId(), email: "op@example.test", role: "admin", status: "active" })
    .returning({ id: users.id });
  admin = adminContextFrom({ userId: adminUser!.id, organizationId: null, role: "admin", status: "active", sessionEpoch: 0 });
});

afterAll(async () => close());

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv("RESEND_FROM_ADDRESS", '"Mortensen Web Co." <hello@mortensenweb.example>');
  vi.stubEnv("AUTH_SECRET", "test-secret");
  vi.stubEnv("AUTH_URL", "https://portal.example");
  outbox = [];
  nextResult = () => ({ status: "sent", id: `re_${outbox.length}` });
  acme = await seedTenant(db, `Acme ${newPublicId().slice(0, 4)}`);
  await db.insert(businessProfiles).values({
    organizationId: acme.organizationId,
    details: { businessName: "Acme Heating", email: "office@acme.example", address: "123 Main St, Riverton, UT" },
  });
  await db.insert(clientAddOns).values({ clientId: acme.clientId, featureKey: "winback", source: "operator" });
});

describe("runWinbackSends", () => {
  it("sends each customer one email, with the business's details and an unsubscribe link", async () => {
    await addContacts(acme, ["dana@example.test", "sam@example.test"]);
    const campaign = await approvedCampaign(acme);

    const result = await runWinbackSends(db, { send, now: () => NOW, sleep: noSleep });
    expect(result.sent).toBe(2);
    expect(outbox.map((m) => m.to).sort()).toEqual(["dana@example.test", "sam@example.test"]);
    const dana = outbox.find((m) => m.to === "dana@example.test")!;
    expect(dana.text.startsWith("Hi Dana,")).toBe(true);
    expect(dana.text).toContain("123 Main St");
    expect(dana.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/portal\.example\/api\/unsubscribe\//);
    expect(dana.replyTo).toBe("office@acme.example");

    const after = await getCampaign(db, acme.ctx, campaign);
    expect(after.status).toBe("sent");
    expect(after.stats.sent).toBe(2);

    // A second run, or a retried one, sends nobody anything.
    outbox = [];
    await runWinbackSends(db, { send, now: () => NOW, sleep: noSleep });
    expect(outbox).toHaveLength(0);
  });

  it("waits for a scheduled day", async () => {
    await addContacts(acme, ["dana@example.test"]);
    const publicId = await createDraft(db, acme.ctx, "check-in");
    await approveCampaign(db, acme.ctx, publicId, { ...text, scheduleDay: "2026-10-28" }, NOW);
    await runWinbackSends(db, { send, now: () => NOW, sleep: noSleep });
    expect(outbox.filter((m) => m.to === "dana@example.test")).toHaveLength(0);
    await runWinbackSends(db, { send, now: () => new Date("2026-10-28T15:05:00Z"), sleep: noSleep });
    expect(outbox.filter((m) => m.to === "dana@example.test")).toHaveLength(1);
  });

  it("skips anyone suppressed, even after the campaign was approved", async () => {
    await addContacts(acme, ["dana@example.test", "gone@example.test"]);
    const campaign = await approvedCampaign(acme);
    await db.insert(winbackSuppressions).values({ organizationId: acme.organizationId, email: "gone@example.test", reason: "unsubscribed" });

    await runWinbackSends(db, { send, now: () => NOW, sleep: noSleep });
    expect(outbox.map((m) => m.to)).toEqual(["dana@example.test"]);
    const rows = await recipients(campaign);
    expect(rows.find((r) => r.email === "gone@example.test")!.status).toBe("suppressed");
  });

  it("backs off on a rate limit and finishes on the next run", async () => {
    await addContacts(acme, ["a@example.test", "b@example.test", "c@example.test"]);
    const campaign = await approvedCampaign(acme);
    nextResult = () => (outbox.length === 2 ? { status: "failed", error: "Resend responded 429", httpStatus: 429 } : { status: "sent", id: `re_${outbox.length}` });

    const first = await runWinbackSends(db, { send, now: () => NOW, sleep: noSleep });
    expect(first.rateLimited).toBe(true);
    expect(first.sent).toBe(1);

    nextResult = () => ({ status: "sent", id: `re_${outbox.length}` });
    await runWinbackSends(db, { send, now: () => NOW, sleep: noSleep });
    const rows = await recipients(campaign);
    expect(rows.every((r) => r.status === "sent")).toBe(true);
    expect(new Set(outbox.filter((m) => m.text.includes("Hi")).map((m) => m.to)).size).toBe(3);
  });

  it("gives up on an address Resend refuses, and carries on", async () => {
    await addContacts(acme, ["bad@example.test", "good@example.test"]);
    const campaign = await approvedCampaign(acme);
    nextResult = (m) => (m.to === "bad@example.test" ? { status: "failed", error: "Resend responded 422", httpStatus: 422 } : { status: "sent", id: "re_ok" });
    await runWinbackSends(db, { send, now: () => NOW, sleep: noSleep });
    const rows = await recipients(campaign);
    expect(rows.find((r) => r.email === "bad@example.test")!.status).toBe("failed");
    expect(rows.find((r) => r.email === "good@example.test")!.status).toBe("sent");
    expect((await getCampaign(db, acme.ctx, campaign)).status).toBe("sent");
  });

  it("holds a campaign whose business no longer has win-back", async () => {
    await addContacts(acme, ["dana@example.test"]);
    const campaign = await approvedCampaign(acme);
    await db.delete(clientAddOns).where(eq(clientAddOns.clientId, acme.clientId));
    const result = await runWinbackSends(db, { send, now: () => NOW, sleep: noSleep });
    expect(result.held).toBeGreaterThanOrEqual(1);
    expect(outbox).toHaveLength(0);
    expect((await getCampaign(db, acme.ctx, campaign)).status).toBe("approved");
  });

  it("records a send this server cannot make as not sent, never as sent", async () => {
    await addContacts(acme, ["dana@example.test"]);
    const campaign = await approvedCampaign(acme);
    nextResult = () => ({ status: "skipped", reason: "no_api_key" });
    await runWinbackSends(db, { send, now: () => NOW, sleep: noSleep });
    const stats = (await getCampaign(db, acme.ctx, campaign)).stats;
    expect(stats.notSent).toBe(1);
    expect(stats.sent).toBe(0);
  });
});

describe("the kill switch", () => {
  it("stops a campaign mid-batch", async () => {
    await addContacts(acme, ["a@example.test", "b@example.test", "c@example.test"]);
    const campaign = await approvedCampaign(acme);
    // The operator presses stop while the first email is going out.
    nextResult = () => ({ status: "sent", id: "re_x" });
    const sendThenHalt = async (m: EmailMessage): Promise<SendResult> => {
      const result = await send(m);
      if (outbox.length === 1) await haltCampaign(admin, db, campaign, "Wrong offer");
      return result;
    };
    await runWinbackSends(db, { send: sendThenHalt, now: () => NOW, sleep: noSleep });
    expect(outbox).toHaveLength(1);
    const after = await getCampaign(db, acme.ctx, campaign);
    expect(after.status).toBe("halted");
    expect(after.haltReason).toBe("Wrong offer");
    expect(after.stats.halted).toBe(2);
  });

  it("stops everything at once", async () => {
    await addContacts(acme, ["a@example.test"]);
    const campaign = await approvedCampaign(acme);
    const result = await haltAllWinback(admin, db, "Pausing all sending");
    expect(result.halted).toBeGreaterThanOrEqual(1);
    await runWinbackSends(db, { send, now: () => NOW, sleep: noSleep });
    expect(outbox).toHaveLength(0);
    expect((await getCampaign(db, acme.ctx, campaign)).status).toBe("halted");
  });

  it("lists every client's campaigns that are not drafts", async () => {
    await addContacts(acme, ["a@example.test"]);
    const campaign = await approvedCampaign(acme);
    await createDraft(db, acme.ctx, "check-in");
    const rows = await listWinbackCampaigns(admin, db);
    const mine = rows.filter((r) => r.organizationId === acme.organizationId);
    expect(mine.map((r) => r.publicId)).toEqual([campaign]);
    expect(mine[0]!.businessName).toBe("Acme Heating");
  });
});

describe("unsubscribe", () => {
  it("suppresses the address for that business and records it on the send", async () => {
    await addContacts(acme, ["dana@example.test"]);
    const campaign = await approvedCampaign(acme);
    await runWinbackSends(db, { send, now: () => NOW, sleep: noSleep });
    const [row] = await recipients(campaign);

    expect((await describeUnsubscribe(db, row!.publicId))).toMatchObject({ businessName: "Acme Heating", done: false });
    expect(await unsubscribeRecipient(db, row!.publicId, { ipHash: "ip1", now: NOW })).toMatchObject({ ok: true });
    expect(await unsubscribeRecipient(db, row!.publicId, { ipHash: "ip1", now: NOW })).toMatchObject({ ok: true });
    const suppressed = await db
      .select()
      .from(winbackSuppressions)
      .where(and(eq(winbackSuppressions.organizationId, acme.organizationId), eq(winbackSuppressions.email, "dana@example.test")));
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]!.reason).toBe("unsubscribed");
    expect((await getCampaign(db, acme.ctx, campaign)).stats.unsubscribed).toBe(1);
  });

  it("does not know a recipient it never sent to", async () => {
    expect(await describeUnsubscribe(db, newPublicId())).toBeNull();
    expect(await unsubscribeRecipient(db, newPublicId(), { ipHash: "ip", now: NOW })).toEqual({ ok: false, reason: "not_found" });
  });

  it("limits how many addresses one connection can unsubscribe in an hour", async () => {
    await addContacts(acme, Array.from({ length: UNSUBSCRIBES_PER_IP_PER_HOUR + 1 }, (_, i) => `u${i}@example.test`));
    const campaign = await approvedCampaign(acme);
    await runWinbackSends(db, { send, now: () => NOW, sleep: noSleep });
    const rows = await recipients(campaign);
    const results = [];
    for (const row of rows) results.push(await unsubscribeRecipient(db, row.publicId, { ipHash: "busy", now: NOW }));
    expect(results.at(-1)).toEqual({ ok: false, reason: "rate_limited" });
  });
});

describe("delivery events", () => {
  async function sentRow() {
    await addContacts(acme, ["dana@example.test"]);
    const campaign = await approvedCampaign(acme);
    nextResult = () => ({ status: "sent", id: `re_${newPublicId()}` });
    await runWinbackSends(db, { send, now: () => NOW, sleep: noSleep });
    const [row] = await recipients(campaign);
    return { campaign, row: row! };
  }

  function event(type: "delivered" | "opened" | "clicked" | "bounced" | "complained", emailId: string, tags: Record<string, string>) {
    return { type, emailId, to: ["dana@example.test"], tags, at: new Date("2026-10-20T17:00:00Z") };
  }

  it("route to win-back by the feature tag and stamp the send once", async () => {
    const { campaign, row } = await sentRow();
    const tags = { feature: "winback", organization: acme.organizationId, winback_recipient: row.publicId };
    expect(await routeDeliveryEvent(db, event("delivered", row.providerMessageId!, tags))).toBe("handled");
    await routeDeliveryEvent(db, event("opened", row.providerMessageId!, tags));
    await routeDeliveryEvent(db, event("opened", row.providerMessageId!, tags));
    await routeDeliveryEvent(db, event("clicked", row.providerMessageId!, tags));
    const stats = (await getCampaign(db, acme.ctx, campaign)).stats;
    expect([stats.delivered, stats.opened, stats.clicked]).toEqual([1, 1, 1]);
  });

  it("suppress the address on a bounce or a complaint", async () => {
    const { row } = await sentRow();
    const tags = { feature: "winback", organization: acme.organizationId, winback_recipient: row.publicId };
    await routeDeliveryEvent(db, event("complained", row.providerMessageId!, tags));
    const [s] = await db
      .select()
      .from(winbackSuppressions)
      .where(and(eq(winbackSuppressions.organizationId, acme.organizationId), eq(winbackSuppressions.email, "dana@example.test")));
    expect(s!.reason).toBe("complained");
  });

  it("ignore an event whose tags name another business", async () => {
    const { campaign, row } = await sentRow();
    const other = await seedTenant(db, "Other");
    await routeDeliveryEvent(db, event("bounced", row.providerMessageId!, { feature: "winback", organization: other.organizationId, winback_recipient: row.publicId }));
    expect((await getCampaign(db, acme.ctx, campaign)).stats.bounced).toBe(0);
  });

  it("leave mail no feature claims alone", async () => {
    expect(await routeDeliveryEvent(db, event("bounced", "re_reset", {}))).toBe("unrouted");
    expect(await routeDeliveryEvent(db, event("bounced", "re_x", { feature: "nobody" }))).toBe("unrouted");
    expect(Object.keys(DELIVERY_EVENT_HANDLERS)).toContain("winback");
  });
});
