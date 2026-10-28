import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, listingSteps, organizationMemberships, organizations, sites, users } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { LISTING_STEP_KEYS, listingProgress } from "@/lib/listings/steps";
import { adminContextFrom, AuthorizationError, NotFoundError, tenantContextFrom, type AdminContext } from "@/db/repositories/context";
import { listListingChecklists, markListingStep, needsListingReminder } from "@/db/repositories/client/listings";
import { listOrganizationChecklists, markListingStepForClient } from "@/db/repositories/admin/listings";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * Get listed: the per-site checklist of directories a business has to be in.
 *
 * What would go wrong quietly: a client ticking a step on another client's
 * site; an admin viewing as a client ticking anything; a note added later
 * rewriting who did the work; the dashboard reminder staying on after half
 * the list is done, or going off before; and a step key nobody defined
 * landing in the table.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let globex: SeededTenant;
let admin: AdminContext;
let adminUserId: string;
let acmeSite: { id: string; publicId: string };

async function addSite(tenant: SeededTenant, name: string) {
  const [row] = await db
    .insert(sites)
    .values({ publicId: newPublicId(), organizationId: tenant.organizationId, name, status: "live" })
    .returning({ id: sites.id, publicId: sites.publicId });
  return row!;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  acme = await seedTenant(db, "Acme");
  globex = await seedTenant(db, "Globex");

  const [adminRow] = await db
    .insert(users)
    .values({ publicId: newPublicId(), email: "operator@example.test", name: "Scott", role: "admin", status: "active" })
    .returning({ id: users.id });
  adminUserId = adminRow!.id;
  admin = adminContextFrom({ userId: adminUserId, organizationId: null, role: "admin", status: "active", sessionEpoch: 0 });
});

afterAll(async () => close());

beforeEach(async () => {
  await db.delete(listingSteps);
  await db.delete(auditLog);
  await db.delete(sites);
  acmeSite = await addSite(acme, "Acme Plumbing");
});

describe("progress", () => {
  it("counts done steps and reminds while fewer than half are done", () => {
    const states = (n: number) => LISTING_STEP_KEYS.map((_, i) => ({ done: i < n }));
    expect(listingProgress(states(0))).toMatchObject({ done: 0, total: 8, label: "0 of 8 done", needsReminder: true });
    expect(listingProgress(states(3)).needsReminder).toBe(true);
    expect(listingProgress(states(4)).needsReminder).toBe(false);
    expect(listingProgress(states(5)).label).toBe("5 of 8 done");
  });
});

describe("the client's checklist", () => {
  it("shows every step as not done before anyone touches it", async () => {
    const [checklist] = await listListingChecklists(db, acme.ctx);
    expect(checklist?.sitePublicId).toBe(acmeSite.publicId);
    expect(checklist?.steps.map((s) => s.key)).toEqual([...LISTING_STEP_KEYS]);
    expect(checklist?.steps.every((s) => !s.done && s.markedBy === null && s.note === null)).toBe(true);
    expect(checklist?.progress.label).toBe("0 of 8 done");
    expect(await needsListingReminder(db, acme.ctx)).toBe(true);
  });

  it("marking a step done records who and when, and the reminder stops at half", async () => {
    const before = Date.now();
    const result = await markListingStep(db, acme.ctx, acmeSite.publicId, { stepKey: "yelp", done: true });
    expect(result).toEqual({ ok: true, message: "Yelp listing claimed: done." });

    const [checklist] = await listListingChecklists(db, acme.ctx);
    const yelp = checklist!.steps.find((s) => s.key === "yelp")!;
    expect(yelp.done).toBe(true);
    expect(yelp.markedBy).toEqual({ userId: acme.userId, name: expect.any(String), role: "client" });
    expect(yelp.markedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(checklist!.progress.label).toBe("1 of 8 done");

    for (const key of ["google_business_profile", "search_console", "bing_webmaster"]) {
      await markListingStep(db, acme.ctx, acmeSite.publicId, { stepKey: key, done: true });
    }
    expect(await needsListingReminder(db, acme.ctx)).toBe(false);
  });

  it("marking a step not done again keeps the row and restamps it", async () => {
    await markListingStep(db, acme.ctx, acmeSite.publicId, { stepKey: "bbb", done: true });
    const undone = await markListingStep(db, acme.ctx, acmeSite.publicId, { stepKey: "bbb", done: false });
    expect(undone).toEqual({ ok: true, message: "Better Business Bureau profile: back to not done." });

    const rows = await db.select().from(listingSteps).where(eq(listingSteps.stepKey, "bbb"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("todo");
    expect(rows[0]!.markedBy).toBe(acme.userId);
  });

  it("a note added later keeps who marked the step done", async () => {
    await markListingStepForClient(admin, db, acme.organizationId, acmeSite.publicId, {
      stepKey: "facebook",
      done: true,
    });
    const noted = await markListingStep(db, acme.ctx, acmeSite.publicId, {
      stepKey: "facebook",
      note: "  https://facebook.com/acmeplumbing  ",
    });
    expect(noted).toEqual({ ok: true, message: "Note saved." });

    const [checklist] = await listListingChecklists(db, acme.ctx);
    const facebook = checklist!.steps.find((s) => s.key === "facebook")!;
    expect(facebook.done).toBe(true);
    expect(facebook.note).toBe("https://facebook.com/acmeplumbing");
    expect(facebook.markedBy).toEqual({ userId: adminUserId, name: "Scott", role: "admin" });
  });

  it("a note on an untouched step creates the row without marking it done", async () => {
    await markListingStep(db, acme.ctx, acmeSite.publicId, { stepKey: "nextdoor", note: "waiting on the postcard" });
    const [checklist] = await listListingChecklists(db, acme.ctx);
    const nextdoor = checklist!.steps.find((s) => s.key === "nextdoor")!;
    expect(nextdoor).toMatchObject({ done: false, note: "waiting on the postcard", markedBy: null, markedAt: null });
  });

  it("refuses an unknown step, an overlong note, and an empty save", async () => {
    await expect(markListingStep(db, acme.ctx, acmeSite.publicId, { stepKey: "tiktok", done: true })).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      markListingStep(db, acme.ctx, acmeSite.publicId, { stepKey: "yelp", note: "x".repeat(501) }),
    ).resolves.toMatchObject({ ok: false, message: expect.stringContaining("500") });
    await expect(markListingStep(db, acme.ctx, acmeSite.publicId, { stepKey: "yelp" })).resolves.toMatchObject({
      ok: false,
    });
    expect(await db.select().from(listingSteps)).toHaveLength(0);
  });
});

describe("who may tick", () => {
  it("another tenant cannot see or mark this tenant's site", async () => {
    await markListingStep(db, acme.ctx, acmeSite.publicId, { stepKey: "yelp", done: true });
    expect(await listListingChecklists(db, globex.ctx)).toEqual([]);
    await expect(
      markListingStep(db, globex.ctx, acmeSite.publicId, { stepKey: "yelp", done: false }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("an admin viewing as the client is read-only", async () => {
    const viewing = tenantContextFrom(
      { userId: adminUserId, organizationId: null, role: "admin", status: "active", sessionEpoch: 0 },
      acme.organizationId,
      { impersonating: true },
    );
    expect(await listListingChecklists(db, viewing)).toHaveLength(1);
    await expect(
      markListingStep(db, viewing, acmeSite.publicId, { stepKey: "yelp", done: true }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("the operator ticks on the client's behalf, scoped to that client, and it is audited", async () => {
    const result = await markListingStepForClient(admin, db, acme.organizationId, acmeSite.publicId, {
      stepKey: "apple_business_connect",
      done: true,
      note: "claimed under the agency's Apple ID",
    });
    expect(result.ok).toBe(true);

    const [forAdmin] = await listOrganizationChecklists(admin, db, acme.organizationId);
    const apple = forAdmin!.steps.find((s) => s.key === "apple_business_connect")!;
    expect(apple).toMatchObject({ done: true, note: "claimed under the agency's Apple ID" });
    expect(apple.markedBy?.role).toBe("admin");

    const [forClient] = await listListingChecklists(db, acme.ctx);
    expect(forClient!.steps.find((s) => s.key === "apple_business_connect")!.markedBy?.name).toBe("Scott");

    const entries = await db.select().from(auditLog).where(eq(auditLog.action, "listing_step.marked"));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actorUserId: adminUserId, organizationId: acme.organizationId, entityId: acmeSite.publicId });

    // The site public id is checked against the organization it is said to belong to.
    await expect(
      markListingStepForClient(admin, db, globex.organizationId, acmeSite.publicId, { stepKey: "yelp", done: true }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("the table", () => {
  it("refuses a step key the list does not define", async () => {
    await expect(
      db.insert(listingSteps).values({
        organizationId: acme.organizationId,
        siteId: acmeSite.id,
        stepKey: "tiktok",
        state: "done",
      }),
    ).rejects.toThrow();
  });

  it("keeps one row per site and step", async () => {
    const row = { organizationId: acme.organizationId, siteId: acmeSite.id, stepKey: "yelp", state: "done" };
    await db.insert(listingSteps).values(row);
    await expect(db.insert(listingSteps).values(row)).rejects.toThrow();
  });

  it("goes with the site", async () => {
    await markListingStep(db, acme.ctx, acmeSite.publicId, { stepKey: "yelp", done: true });
    await db.delete(sites).where(eq(sites.id, acmeSite.id));
    expect(await db.select().from(listingSteps)).toHaveLength(0);
    // Memberships are untouched by any of this; the tenant can still act.
    expect(await db.select().from(organizationMemberships)).not.toHaveLength(0);
    expect(await db.select().from(organizations)).not.toHaveLength(0);
  });
});
