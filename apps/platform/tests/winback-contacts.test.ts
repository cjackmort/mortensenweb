import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { eventBookings, leads, sites, winbackContacts, winbackSuppressions } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import {
  forgetDeletedLead,
  importContacts,
  listContacts,
  recordLeadOutcome,
  removeContact,
  syncWonLeads,
} from "@/db/repositories/client/winback-contacts";
import { AuthorizationError, NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * The past-customer list.
 *
 * What would go wrong quietly: a won enquiry never reaching the list because
 * the inbox later archived it; the same customer twice; a client seeing or
 * removing another client's customers; and an operator viewing as the client
 * changing their list.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let globex: SeededTenant;

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
    name: "Dana Reyes",
    email: "Dana@Example.test",
    receivedAt: new Date("2026-10-01T15:00:00Z"),
    ...values,
  });
  return publicId;
}

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  acme = await seedTenant(db, "Acme Heating");
  globex = await seedTenant(db, "Globex");
});

afterAll(async () => close());

describe("won enquiries", () => {
  it("become a customer the moment they are marked won, and stay one when archived", async () => {
    const lead = await addLead(acme, { status: "won" });
    await recordLeadOutcome(db, acme.ctx, lead, "won");
    const [contact] = await db
      .select()
      .from(winbackContacts)
      .where(and(eq(winbackContacts.organizationId, acme.organizationId), eq(winbackContacts.email, "dana@example.test")));
    expect(contact!.source).toBe("lead");
    expect(contact!.howBecameCustomer).toMatch(/won enquiry from your website, Oct 1, 2026/i);

    // The inbox trims itself by archiving; that is not the client changing their mind.
    await recordLeadOutcome(db, acme.ctx, lead, "archived");
    expect((await listContacts(db, acme.ctx)).contacts.map((c) => c.email)).toContain("dana@example.test");
  });

  it("stop being one when the client changes won to lost", async () => {
    const lead = await addLead(acme, { email: "sam@example.test", status: "won" });
    await recordLeadOutcome(db, acme.ctx, lead, "won");
    await recordLeadOutcome(db, acme.ctx, lead, "lost");
    expect((await listContacts(db, acme.ctx)).contacts.map((c) => c.email)).not.toContain("sam@example.test");
  });

  it("are all brought in by a sync, once", async () => {
    await addLead(acme, { email: "pat@example.test", status: "won" });
    await addLead(acme, { email: "lee@example.test", status: "contacted" });
    const first = await syncWonLeads(db, acme.ctx);
    const again = await syncWonLeads(db, acme.ctx);
    expect(first.added).toBeGreaterThanOrEqual(1);
    expect(again.added).toBe(0);
    const emails = (await listContacts(db, acme.ctx)).contacts.map((c) => c.email);
    expect(emails).toContain("pat@example.test");
    expect(emails).not.toContain("lee@example.test");
  });

  it("never include a performer whose booking enquiry was approved", async () => {
    const lead = await addLead(acme, { email: "band@example.test", status: "won", formName: "booking" });
    const [row] = await db.select({ id: leads.id, siteId: leads.siteId }).from(leads).where(eq(leads.publicId, lead));
    await db.insert(eventBookings).values({
      publicId: newPublicId(),
      organizationId: acme.organizationId,
      siteId: row!.siteId,
      leadId: row!.id,
      decision: "approved",
      actName: "The Band",
      eventDate: "2026-11-07",
    });
    await recordLeadOutcome(db, acme.ctx, lead, "won");
    await syncWonLeads(db, acme.ctx);
    expect((await listContacts(db, acme.ctx)).contacts.map((c) => c.email)).not.toContain("band@example.test");
  });

  it("leave with the enquiry when it is deleted", async () => {
    const lead = await addLead(acme, { email: "gone-lead@example.test", status: "won" });
    await recordLeadOutcome(db, acme.ctx, lead, "won");
    await forgetDeletedLead(db, acme.ctx, lead);
    expect((await listContacts(db, acme.ctx)).contacts.map((c) => c.email)).not.toContain("gone-lead@example.test");
  });

  it("are skipped when the enquiry left no email", async () => {
    const lead = await addLead(acme, { email: null, status: "won" });
    await expect(recordLeadOutcome(db, acme.ctx, lead, "won")).resolves.toBeUndefined();
  });
});

describe("importContacts", () => {
  it("adds new customers and counts the ones it already had", async () => {
    const result = await importContacts(db, acme.ctx, {
      fileName: "customers.csv",
      contacts: [
        { email: "dana@example.test", name: "Dana", lastJobOn: null, note: null },
        { email: "new@example.test", name: "New Person", lastJobOn: "2025-11-03", note: "Furnace install" },
      ],
    });
    expect(result).toEqual({ added: 1, alreadyHad: 1 });
    const [row] = await db.select().from(winbackContacts).where(eq(winbackContacts.email, "new@example.test"));
    expect(row!.howBecameCustomer).toMatch(/^Imported from customers\.csv on .+ · Furnace install$/);
    expect(row!.lastJobOn).toBe("2025-11-03");
  });

  it("is refused while an operator is viewing as the client", async () => {
    const viewing = tenantContextFrom(
      { userId: acme.userId, organizationId: acme.organizationId, role: "admin", status: "active", sessionEpoch: 0 },
      acme.organizationId,
      { impersonating: true },
    );
    await expect(
      importContacts(db, viewing, { fileName: "x.csv", contacts: [{ email: "x@example.test", name: null, lastJobOn: null, note: null }] }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("listContacts", () => {
  it("marks the ones who asked not to be emailed", async () => {
    await db.insert(winbackSuppressions).values({ organizationId: acme.organizationId, email: "new@example.test", reason: "unsubscribed" });
    const { contacts, total, reachable } = await listContacts(db, acme.ctx);
    expect(contacts.find((c) => c.email === "new@example.test")!.suppressed).toBe("unsubscribed");
    expect(contacts.find((c) => c.email === "dana@example.test")!.suppressed).toBeNull();
    expect(reachable).toBe(total - 1);
  });

  it("never shows another business's customers", async () => {
    expect((await listContacts(db, globex.ctx)).contacts).toEqual([]);
  });
});

describe("removeContact", () => {
  it("removes their own customer, and not another business's", async () => {
    const { contacts } = await listContacts(db, acme.ctx);
    const target = contacts.find((c) => c.email === "dana@example.test")!;
    await expect(removeContact(db, globex.ctx, target.publicId)).rejects.toBeInstanceOf(NotFoundError);
    await removeContact(db, acme.ctx, target.publicId);
    expect((await listContacts(db, acme.ctx)).contacts.map((c) => c.email)).not.toContain("dana@example.test");
  });
});
