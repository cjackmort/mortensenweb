import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { businessProfiles, leadReplies, leads, sites } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import type { EmailMessage, SendResult } from "@/lib/email/mailer";
import { buildLeadReplyEmail, fromHeader, replySenderAddress, REPLIES_PER_HOUR } from "@/lib/growth/lead-reply";
import { listLeadReplies, sendLeadReply } from "@/db/repositories/client/lead-replies";
import { AuthorizationError, NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * Replying to a lead from the portal.
 *
 * What would go wrong quietly: a reply going out under a header the client's
 * business name was able to rewrite; a reply that failed leaving no trace, so
 * the client believes the customer was answered; and a client able to send
 * from another client's enquiry.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let globex: SeededTenant;

const outbox: EmailMessage[] = [];
const delivered = async (message: EmailMessage): Promise<SendResult> => {
  outbox.push(message);
  return { status: "sent", id: "re_123" };
};

async function addLead(
  tenant: SeededTenant,
  values: Partial<typeof leads.$inferInsert> = {},
): Promise<string> {
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
    name: "Dana Reyes",
    email: "dana@example.test",
    message: "Water heater is leaking.",
    receivedAt: new Date("2026-10-01T15:00:00Z"),
    ...values,
  });
  return publicId;
}

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  acme = await seedTenant(db, "Acme Plumbing");
  globex = await seedTenant(db, "Globex");
  await db.insert(businessProfiles).values({
    organizationId: acme.organizationId,
    details: { businessName: "Acme Plumbing & Heating", email: "office@acme.example" },
  });
});

afterAll(async () => {
  await close();
});

beforeEach(() => {
  outbox.length = 0;
  vi.unstubAllEnvs();
  vi.stubEnv("RESEND_FROM_ADDRESS", '"Mortensen Web Co." <hello@mortensenweb.example>');
});

describe("the reply email", () => {
  it("comes from our address under the business's name, and answers go to the business", () => {
    const message = buildLeadReplyEmail({
      businessName: "Acme Plumbing",
      senderAddress: "hello@mortensenweb.example",
      replyTo: "office@acme.example",
      to: "dana@example.test",
      body: "We can come Thursday at 9.",
      original: { message: "Leaking <b>badly</b>", receivedOn: "Oct 1, 2026" },
    });
    expect(message.from).toBe('"Acme Plumbing" <hello@mortensenweb.example>');
    expect(message.replyTo).toBe("office@acme.example");
    expect(message.bcc).toBe("office@acme.example");
    expect(message.to).toBe("dana@example.test");
    expect(message.text).toContain("> Leaking <b>badly</b>");
    expect(message.html).toContain("&lt;b&gt;badly&lt;/b&gt;");
    expect(message.html).not.toContain("<b>badly");
  });

  it("cannot be steered by a business name that tries to rewrite the header", () => {
    const header = fromHeader('Evil" <attacker@bad.example>\r\nBcc: everyone@x', "hello@ours.example");
    expect(header).toMatch(/^"[^"<>\r\n]*" <hello@ours\.example>$/);
  });

  it("sends from the address configured for it, or the one inside RESEND_FROM_ADDRESS", () => {
    expect(replySenderAddress({ RESEND_FROM_ADDRESS: '"Us" <hello@ours.example>' })).toBe("hello@ours.example");
    expect(replySenderAddress({ RESEND_FROM_ADDRESS: "hello@ours.example" })).toBe("hello@ours.example");
    expect(
      replySenderAddress({ LEADS_REPLY_FROM_ADDRESS: "replies@ours.example", RESEND_FROM_ADDRESS: "hello@ours.example" }),
    ).toBe("replies@ours.example");
    expect(replySenderAddress({})).toBeNull();
  });
});

describe("sending a reply", () => {
  it("emails the customer, keeps the record, and marks a new lead contacted", async () => {
    const lead = await addLead(acme);
    const result = await sendLeadReply(db, acme.ctx, lead, "  We can come Thursday at 9.  ", { send: delivered });

    expect(result).toEqual({ ok: true, status: "sent" });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toBe("dana@example.test");
    expect(outbox[0]!.from).toBe('"Acme Plumbing & Heating" <hello@mortensenweb.example>');
    expect(outbox[0]!.replyTo).toBe("office@acme.example");

    const replies = await listLeadReplies(db, acme.ctx, lead);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ body: "We can come Thursday at 9.", status: "sent" });

    const [row] = await db.select({ status: leads.status }).from(leads).where(eq(leads.publicId, lead));
    expect(row!.status).toBe("contacted");
  });

  it("leaves a won lead won", async () => {
    const lead = await addLead(acme, { status: "won" });
    await sendLeadReply(db, acme.ctx, lead, "Thanks again!", { send: delivered });
    const [row] = await db.select({ status: leads.status }).from(leads).where(eq(leads.publicId, lead));
    expect(row!.status).toBe("won");
  });

  it("records a failed send, says so, and does not mark the lead contacted", async () => {
    const lead = await addLead(acme);
    const result = await sendLeadReply(db, acme.ctx, lead, "Hello", {
      send: async () => ({ status: "failed", error: "Resend responded 500" }),
    });

    expect(result.ok).toBe(false);
    const replies = await listLeadReplies(db, acme.ctx, lead);
    expect(replies[0]!.status).toBe("failed");
    const [row] = await db.select({ status: leads.status }).from(leads).where(eq(leads.publicId, lead));
    expect(row!.status).toBe("new");
  });

  it("refuses an empty reply, and an enquiry with no email address", async () => {
    const lead = await addLead(acme);
    expect(await sendLeadReply(db, acme.ctx, lead, "   ", { send: delivered })).toMatchObject({ ok: false });

    const noEmail = await addLead(acme, { email: null });
    expect(await sendLeadReply(db, acme.ctx, noEmail, "Hi", { send: delivered })).toMatchObject({ ok: false });
    expect(outbox).toHaveLength(0);
  });

  it("refuses to send until a sender address is configured", async () => {
    vi.stubEnv("RESEND_FROM_ADDRESS", "");
    const lead = await addLead(acme);
    expect(await sendLeadReply(db, acme.ctx, lead, "Hi", { send: delivered })).toMatchObject({ ok: false });
    expect(outbox).toHaveLength(0);
  });

  it("treats another client's enquiry as not found", async () => {
    const theirs = await addLead(globex);
    await expect(sendLeadReply(db, acme.ctx, theirs, "Hi", { send: delivered })).rejects.toBeInstanceOf(NotFoundError);
    expect(await listLeadReplies(db, acme.ctx, theirs)).toEqual([]);
    expect(outbox).toHaveLength(0);
  });

  it("refuses while an operator is viewing as the client", async () => {
    const lead = await addLead(acme);
    const operator = tenantContextFrom(
      { userId: acme.userId, organizationId: acme.organizationId, role: "admin", status: "active", sessionEpoch: 0 },
      acme.organizationId,
      { impersonating: true },
    );
    await expect(sendLeadReply(db, operator, lead, "Hi", { send: delivered })).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("falls back to the signed-in person's email when the business has none on file", async () => {
    const lead = await addLead(globex);
    await sendLeadReply(db, globex.ctx, lead, "Hi", { send: delivered });
    expect(outbox[0]!.replyTo).toMatch(/@example\.test$/);
  });

  it("stops at the hourly limit", async () => {
    const lead = await addLead(globex);
    const now = new Date("2030-01-01T12:00:00Z");
    // A full hour's worth, a minute ago.
    const [row] = await db.select({ id: leads.id }).from(leads).where(eq(leads.publicId, lead));
    await db.insert(leadReplies).values(
      Array.from({ length: REPLIES_PER_HOUR }, () => ({
        publicId: newPublicId(),
        organizationId: globex.organizationId,
        leadId: row!.id,
        body: "x",
        replyTo: "x@example.test",
        status: "sent",
        createdAt: new Date(now.getTime() - 60_000),
      })),
    );

    const result = await sendLeadReply(db, globex.ctx, lead, "One more", { send: delivered, now });
    expect(result).toMatchObject({ ok: false });
    expect(outbox).toHaveLength(0);
  });
});
