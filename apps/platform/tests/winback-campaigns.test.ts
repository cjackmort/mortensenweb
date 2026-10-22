import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, businessProfiles, clients, winbackCampaigns, winbackContacts } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import {
  approveCampaign,
  cancelCampaign,
  createDraft,
  deleteDraft,
  getCampaign,
  saveDraft,
  winbackOverview,
} from "@/db/repositories/client/winback-campaigns";
import { AuthorizationError, NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * Win-back campaigns from the client's side: proposed, edited, approved.
 *
 * What would go wrong quietly: a campaign approved without the postal address
 * CAN-SPAM requires; a campaign that changes after approval; one client
 * reading or approving another's; and an operator viewing as the client
 * approving on their behalf.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let globex: SeededTenant;
const NOW = new Date("2026-10-20T16:00:00Z");

const text = {
  name: "Furnace check",
  subject: "Is your furnace ready?",
  body: "Hi {first_name},\n\nCold weather is coming.",
  offer: "",
  offerExpiresOn: "",
};

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  acme = await seedTenant(db, "Acme Heating");
  globex = await seedTenant(db, "Globex");
  await db.update(clients).set({ industry: "HVAC" }).where(eq(clients.id, acme.clientId));
  await db.insert(businessProfiles).values({
    organizationId: acme.organizationId,
    details: {
      businessName: "Acme Heating & Air",
      phone: "801-555-0142",
      email: "office@acme.example",
      address: "123 Main St\nRiverton, UT 84065",
      services: "Furnace tune-up\nA/C repair",
    },
  });
  await db.insert(businessProfiles).values({ organizationId: globex.organizationId, details: { businessName: "Globex" } });
  await db.insert(winbackContacts).values([
    { publicId: newPublicId(), organizationId: acme.organizationId, email: "dana@example.test", name: "Dana Reyes", source: "import", howBecameCustomer: "x" },
    { publicId: newPublicId(), organizationId: globex.organizationId, email: "g@example.test", source: "import", howBecameCustomer: "x" },
  ]);
});

afterAll(async () => close());

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("RESEND_FROM_ADDRESS", '"Mortensen Web Co." <hello@mortensenweb.example>');
  vi.stubEnv("AUTH_SECRET", "test-secret");
  vi.stubEnv("AUTH_URL", "https://portal.example");
});

describe("winbackOverview", () => {
  it("proposes what fits the trade and the season", async () => {
    const overview = await winbackOverview(db, acme.ctx, NOW);
    expect(overview.businessType).toBe("hvac");
    expect(overview.suggestions.map((s) => s.key)).toContain("hvac-furnace");
    expect(overview.reachable).toBe(1);
    expect(overview.readiness.ready).toBe(true);
  });

  it("says what is missing for a business with no postal address", async () => {
    const overview = await winbackOverview(db, globex.ctx, NOW);
    expect(overview.readiness.missing).toContain("postal_address");
  });
});

describe("drafts", () => {
  it("start from a suggestion, written from the profile", async () => {
    const publicId = await createDraft(db, acme.ctx, "hvac-furnace");
    const campaign = await getCampaign(db, acme.ctx, publicId);
    expect(campaign.status).toBe("draft");
    expect(campaign.body).toContain("Acme Heating & Air");
    expect(campaign.body).toContain("801-555-0142");
    expect(campaign.offer).toBeNull();
    // Once drafted, the suggestion is not offered again.
    const overview = await winbackOverview(db, acme.ctx, NOW);
    expect(overview.suggestions.map((s) => s.key)).not.toContain("hvac-furnace");
  });

  it("refuses an occasion that does not exist", async () => {
    await expect(createDraft(db, acme.ctx, "nope")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("are edited by their own business only", async () => {
    const publicId = await createDraft(db, acme.ctx, "check-in");
    const saved = await saveDraft(db, acme.ctx, publicId, { ...text, offer: "$20 off", offerExpiresOn: "2026-11-30" }, NOW);
    expect(saved.ok).toBe(true);
    expect((await getCampaign(db, acme.ctx, publicId)).offer).toBe("$20 off");
    await expect(getCampaign(db, globex.ctx, publicId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(saveDraft(db, globex.ctx, publicId, text, NOW)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("can be deleted while still drafts", async () => {
    const publicId = await createDraft(db, acme.ctx, "check-in");
    await deleteDraft(db, acme.ctx, publicId);
    await expect(getCampaign(db, acme.ctx, publicId)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("approveCampaign", () => {
  it("records who approved it, what it will say, and when it goes", async () => {
    const publicId = await createDraft(db, acme.ctx, "hvac-furnace");
    const result = await approveCampaign(db, acme.ctx, publicId, { ...text, scheduleDay: "2026-10-28" }, NOW);
    expect(result).toMatchObject({ ok: true, sendsNow: false, message: expect.stringMatching(/Oct 28/) });

    const [row] = await db.select().from(winbackCampaigns).where(eq(winbackCampaigns.publicId, publicId));
    expect(row!.status).toBe("approved");
    expect(row!.approvedBy).toBe(acme.userId);
    expect(row!.subject).toBe(text.subject);
    expect(row!.fromName).toBe("Acme Heating & Air");
    expect(row!.replyTo).toBe("office@acme.example");
    expect(row!.postalAddress).toBe("123 Main St\nRiverton, UT 84065");
    expect(row!.scheduledFor!.toISOString()).toBe("2026-10-28T15:00:00.000Z");

    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, publicId));
    expect(audits.map((a) => a.action)).toContain("winback.campaign_approved");
  });

  it("cannot be edited once approved", async () => {
    const publicId = await createDraft(db, acme.ctx, "hvac-furnace");
    await approveCampaign(db, acme.ctx, publicId, { ...text, scheduleDay: "" }, NOW);
    const saved = await saveDraft(db, acme.ctx, publicId, { ...text, subject: "Changed" }, NOW);
    expect(saved.ok).toBe(false);
    const again = await approveCampaign(db, acme.ctx, publicId, { ...text, scheduleDay: "" }, NOW);
    expect(again.ok).toBe(false);
  });

  it("is refused without a postal address, naming what is missing", async () => {
    const publicId = await createDraft(db, globex.ctx, "check-in");
    const result = await approveCampaign(db, globex.ctx, publicId, { ...text, scheduleDay: "" }, NOW);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/postal address/i);
    const [row] = await db.select().from(winbackCampaigns).where(eq(winbackCampaigns.publicId, publicId));
    expect(row!.status).toBe("draft");
  });

  it("is refused for a day already past, or an offer ending before it goes", async () => {
    const publicId = await createDraft(db, acme.ctx, "check-in");
    expect((await approveCampaign(db, acme.ctx, publicId, { ...text, scheduleDay: "2026-10-01" }, NOW)).ok).toBe(false);
    expect(
      (await approveCampaign(db, acme.ctx, publicId, { ...text, offer: "10% off", offerExpiresOn: "2026-10-25", scheduleDay: "2026-10-28" }, NOW)).ok,
    ).toBe(false);
  });

  it("is refused while an operator is viewing as the client", async () => {
    const publicId = await createDraft(db, acme.ctx, "check-in");
    const viewing = tenantContextFrom(
      { userId: acme.userId, organizationId: acme.organizationId, role: "admin", status: "active", sessionEpoch: 0 },
      acme.organizationId,
      { impersonating: true },
    );
    await expect(approveCampaign(db, viewing, publicId, { ...text, scheduleDay: "" }, NOW)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("is refused with nobody to send to", async () => {
    const empty = await seedTenant(db, "Empty Co");
    await db.insert(businessProfiles).values({ organizationId: empty.organizationId, details: { businessName: "Empty", address: "1 Elm St" } });
    const publicId = await createDraft(db, empty.ctx, "check-in");
    const result = await approveCampaign(db, empty.ctx, publicId, { ...text, scheduleDay: "" }, NOW);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/customers/i);
  });
});

describe("cancelCampaign", () => {
  it("takes back an approved campaign before it goes", async () => {
    const publicId = await createDraft(db, acme.ctx, "check-in");
    await approveCampaign(db, acme.ctx, publicId, { ...text, scheduleDay: "2026-11-02" }, NOW);
    expect((await cancelCampaign(db, acme.ctx, publicId)).ok).toBe(true);
    expect((await getCampaign(db, acme.ctx, publicId)).status).toBe("cancelled");
  });
});
