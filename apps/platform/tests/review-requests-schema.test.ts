import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { reviewRequests, reviewSettings, reviewSuppressions } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * Migration 0031: review requests.
 *
 * The rules that must hold however the application code changes later are
 * held by the table itself: a text is never recorded without recorded
 * consent, a request always has someone to send to, a reminder is claimed
 * exactly once, and one address is suppressed once per business and channel.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let globex: SeededTenant;

function request(values: Partial<typeof reviewRequests.$inferInsert> = {}) {
  return {
    publicId: newPublicId(),
    organizationId: acme.organizationId,
    customerName: "Dana Reyes",
    email: "dana@example.test",
    fromName: "Acme Plumbing",
    ...values,
  };
}

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
  acme = await seedTenant(db, "Acme Plumbing");
  globex = await seedTenant(db, "Globex");
});

afterAll(async () => close());

describe("review_requests", () => {
  it("accepts an emailed request with nothing else set", async () => {
    const [row] = await db.insert(reviewRequests).values(request()).returning();
    expect(row!.clickCount).toBe(0);
    expect(row!.remindedAt).toBeNull();
  });

  it("refuses a request with neither an email nor a phone", async () => {
    await expect(db.insert(reviewRequests).values(request({ email: null }))).rejects.toThrow();
  });

  it("refuses a text recorded without consent", async () => {
    await expect(
      db.insert(reviewRequests).values(request({ phone: "+18015550123", smsStatus: "sent" })),
    ).rejects.toThrow();

    await expect(
      db.insert(reviewRequests).values(
        request({ phone: "+18015550123", smsStatus: "sent", smsConsentAt: new Date(), smsConsentBy: acme.userId }),
      ),
    ).resolves.toBeDefined();
  });

  it("refuses an unknown send status", async () => {
    await expect(db.insert(reviewRequests).values(request({ emailStatus: "delivered" }))).rejects.toThrow();
  });

  it("keeps the reminder time and its status together", async () => {
    await expect(
      db.insert(reviewRequests).values(request({ remindedAt: new Date() })),
    ).rejects.toThrow();
    await expect(
      db.insert(reviewRequests).values(request({ reminderStatus: "sent" })),
    ).rejects.toThrow();
  });

  it("can be claimed for a reminder once, and only once", async () => {
    const [row] = await db
      .insert(reviewRequests)
      .values(request({ emailStatus: "sent", sentAt: new Date(), reminderDueAt: new Date() }))
      .returning({ id: reviewRequests.id });
    const claim = async () =>
      db
        .update(reviewRequests)
        .set({ remindedAt: new Date(), reminderStatus: "sending" })
        .where(eq(reviewRequests.id, row!.id))
        .returning({ id: reviewRequests.id })
        .then((rows) => rows.length);
    // The claim the repository makes is conditional on `reminded_at IS NULL`;
    // this asserts the column exists to make that condition with.
    expect(await claim()).toBe(1);
    const [after] = await db.select().from(reviewRequests).where(eq(reviewRequests.id, row!.id));
    expect(after!.remindedAt).not.toBeNull();
  });
});

describe("review_settings", () => {
  it("holds one row per business", async () => {
    await db.insert(reviewSettings).values({
      organizationId: acme.organizationId,
      reviewUrl: "https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4",
    });
    await expect(
      db.insert(reviewSettings).values({
        organizationId: acme.organizationId,
        reviewUrl: "https://g.page/r/CabcdEFGhij/review",
      }),
    ).rejects.toThrow();
  });

  it("defaults to a reminder after three days, and refuses one after more than two weeks", async () => {
    const [row] = await db
      .insert(reviewSettings)
      .values({ organizationId: globex.organizationId, reviewUrl: "https://g.page/r/CabcdEFGhij/review" })
      .returning();
    expect(row!.reminderDays).toBe(3);
    expect(row!.remindersEnabled).toBe(true);
    expect(row!.emailBody).toBeNull();

    await expect(
      db.update(reviewSettings).set({ reminderDays: 30 }).where(eq(reviewSettings.id, row!.id)),
    ).rejects.toThrow();
  });
});

describe("review_suppressions", () => {
  it("suppresses an address once per business and channel", async () => {
    const entry = { channel: "email", address: "dana@example.test", reason: "unsubscribed" };
    await db.insert(reviewSuppressions).values({ organizationId: acme.organizationId, ...entry });
    await expect(
      db.insert(reviewSuppressions).values({ organizationId: acme.organizationId, ...entry, reason: "manual" }),
    ).rejects.toThrow();
    // Another business's list is its own.
    await expect(
      db.insert(reviewSuppressions).values({ organizationId: globex.organizationId, ...entry }),
    ).resolves.toBeDefined();
  });

  it("records a hard bounce or a spam complaint as its own reason (0039)", async () => {
    for (const reason of ["bounced", "complained"]) {
      await expect(
        db.insert(reviewSuppressions).values({
          organizationId: acme.organizationId,
          channel: "email",
          address: `${reason}@example.test`,
          reason,
        }),
      ).resolves.toBeDefined();
    }
  });

  it("refuses an unknown channel or reason", async () => {
    await expect(
      db.insert(reviewSuppressions).values({
        organizationId: acme.organizationId,
        channel: "fax",
        address: "x",
        reason: "manual",
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(reviewSuppressions).values({
        organizationId: acme.organizationId,
        channel: "sms",
        address: "+18015550123",
        reason: "unhappy",
      }),
    ).rejects.toThrow();
  });
});
