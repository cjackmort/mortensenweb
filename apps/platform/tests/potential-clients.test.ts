import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  auditLog,
  clients,
  organizations,
  prospectContacts,
  prospects,
  users,
} from "@/db/schema";
import {
  adminContextFrom,
  NotFoundError,
  type AdminContext,
} from "@/db/repositories/context";
import { listClients } from "@/db/repositories/admin/clients";
import { createProspect } from "@/db/repositories/admin/prospects";
import {
  archivePotentialClient,
  getPotentialClient,
  listPotentialClients,
  updatePotentialClient,
} from "@/db/repositories/admin/potential-clients";
import { createTestDb } from "./helpers/db";

/**
 * Potential clients, listed under the real ones on the Clients page.
 *
 * They live in `prospects`, not `clients`, so nothing that bills, reports on,
 * emails or dispatches work for a client can pick one up. These tests pin
 * that separation as well as the add / edit / remove flow the operator uses.
 */

let db: Database;
let close: () => Promise<void>;
let ctx: AdminContext;

async function addProspect(businessName: string, extra: Record<string, string> = {}) {
  const created = await createProspect(ctx, db, { businessName, ...extra });
  if (!created.ok) throw new Error(created.message);
  return created.publicId;
}

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
});

afterAll(async () => close());

beforeEach(async () => {
  await db.delete(auditLog);
  await db.delete(prospectContacts);
  await db.delete(prospects);
  await db.delete(clients);
  await db.delete(organizations);
  await db.delete(users);

  const adminId = (
    await db
      .insert(users)
      .values({ publicId: "admin-1", email: "admin@example.test", role: "admin", status: "active" })
      .returning()
  )[0]!.id;
  ctx = adminContextFrom({
    userId: adminId,
    organizationId: null,
    role: "admin",
    status: "active",
    sessionEpoch: 0,
  });
});

describe("listPotentialClients", () => {
  it("returns each prospect with its contact, newest activity first", async () => {
    await addProspect("Older Plumbing", { contactName: "Pat", contactEmail: "PAT@Example.test" });
    await addProspect("Newer Bakery", { contactPhone: "555-0100", location: "Provo, UT" });

    const list = await listPotentialClients(ctx, db);

    expect(list.map((p) => p.businessName)).toEqual(["Newer Bakery", "Older Plumbing"]);
    expect(list[0]).toMatchObject({ contactPhone: "555-0100", location: "Provo, UT", contactName: null });
    expect(list[1]).toMatchObject({ contactName: "Pat", contactEmail: "pat@example.test" });
  });

  it("leaves out removed and converted prospects", async () => {
    const removed = await addProspect("Removed Co");
    const converted = await addProspect("Converted Co");
    await addProspect("Still Pitching");
    await archivePotentialClient(ctx, db, removed);
    await db.update(prospects).set({ status: "converted" }).where(eq(prospects.publicId, converted));

    const list = await listPotentialClients(ctx, db);

    expect(list.map((p) => p.businessName)).toEqual(["Still Pitching"]);
  });

  it("returns an empty list when there are none", async () => {
    expect(await listPotentialClients(ctx, db)).toEqual([]);
  });
});

describe("prospects never count as clients", () => {
  it("does not create an organization or a client record", async () => {
    await addProspect("Just A Lead", { contactEmail: "lead@example.test" });

    expect(await listClients(ctx, db)).toEqual([]);
    expect(await db.select().from(organizations)).toEqual([]);
    expect(await db.select().from(users).where(eq(users.email, "lead@example.test"))).toEqual([]);
  });
});

describe("updatePotentialClient", () => {
  it("saves the edited details and records who changed them", async () => {
    const publicId = await addProspect("Draft Name");

    const outcome = await updatePotentialClient(ctx, db, publicId, {
      businessName: "Final Name",
      sourceWebsiteUrl: "finalname.com",
      industry: "roofing",
      location: "Orem, UT",
      notes: "Met at the expo",
      contactName: "Sam",
      contactEmail: "Sam@Example.test",
      contactPhone: "555-0199",
    });

    expect(outcome).toEqual({ ok: true });
    const saved = await getPotentialClient(ctx, db, publicId);
    expect(saved).toMatchObject({
      businessName: "Final Name",
      sourceWebsiteUrl: "https://finalname.com/",
      industry: "roofing",
      location: "Orem, UT",
      notes: "Met at the expo",
      contactName: "Sam",
      contactEmail: "sam@example.test",
      contactPhone: "555-0199",
    });
    const entries = await db.select().from(auditLog).where(eq(auditLog.action, "prospect.updated"));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entityId).toBe(publicId);
  });

  it("edits the existing contact rather than adding a second one", async () => {
    const publicId = await addProspect("One Contact", { contactName: "First" });

    await updatePotentialClient(ctx, db, publicId, { businessName: "One Contact", contactName: "Renamed" });

    const contacts = await db.select().from(prospectContacts);
    expect(contacts.map((c) => c.name)).toEqual(["Renamed"]);
  });

  it("clears a field the operator emptied", async () => {
    const publicId = await addProspect("Has Notes", { notes: "old note", industry: "dental" });

    await updatePotentialClient(ctx, db, publicId, { businessName: "Has Notes", notes: "  ", industry: "" });

    const saved = await getPotentialClient(ctx, db, publicId);
    expect(saved.notes).toBeNull();
    expect(saved.industry).toBeNull();
  });

  it("refuses a missing business name without saving anything", async () => {
    const publicId = await addProspect("Keep Me");

    const outcome = await updatePotentialClient(ctx, db, publicId, { businessName: " " });

    expect(outcome).toMatchObject({ ok: false, reason: "invalid_name" });
    expect((await getPotentialClient(ctx, db, publicId)).businessName).toBe("Keep Me");
  });

  it("refuses a website address that is not one", async () => {
    const publicId = await addProspect("Bad Link");

    const outcome = await updatePotentialClient(ctx, db, publicId, {
      businessName: "Bad Link",
      sourceWebsiteUrl: "not a url",
    });

    expect(outcome).toMatchObject({ ok: false, reason: "invalid_url" });
  });

  it("throws NotFoundError for an unknown or removed prospect", async () => {
    const removed = await addProspect("Gone");
    await archivePotentialClient(ctx, db, removed);

    await expect(updatePotentialClient(ctx, db, "nope", { businessName: "X Co" })).rejects.toThrow(NotFoundError);
    await expect(updatePotentialClient(ctx, db, removed, { businessName: "X Co" })).rejects.toThrow(NotFoundError);
  });
});

describe("archivePotentialClient", () => {
  it("removes it from the list but keeps the record", async () => {
    const publicId = await addProspect("Not Interested");

    await archivePotentialClient(ctx, db, publicId);

    const row = (await db.select().from(prospects).where(eq(prospects.publicId, publicId)))[0]!;
    expect(row.archivedAt).not.toBeNull();
    const entries = await db.select().from(auditLog).where(eq(auditLog.action, "prospect.archived"));
    expect(entries).toHaveLength(1);
  });

  it("throws NotFoundError for an unknown prospect", async () => {
    await expect(archivePotentialClient(ctx, db, "nope")).rejects.toThrow(NotFoundError);
  });
});
