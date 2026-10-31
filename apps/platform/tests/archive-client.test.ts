import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  auditLog,
  clients,
  organizations,
  payments,
  sites,
  subscriptions,
  users,
} from "@/db/schema";
import { adminContextFrom, type AdminContext } from "@/db/repositories/context";
import {
  archiveClient,
  clientsWithLiveStripeBilling,
  listArchivedClients,
  listClients,
  restoreClient,
} from "@/db/repositories/admin/clients";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * Removing a client from the Clients page.
 *
 * "Remove" archives: `clients.archived_at` is set and every client-facing list
 * already filters on it, so the client leaves the grid and the billing
 * rollups. Nothing is deleted — payments, subscriptions, the site and the
 * organization stay exactly as they were, and nothing is sent to GitHub,
 * Netlify or the domain registrar. The one thing that stops it is a live
 * Stripe subscription, because archiving would hide a customer who is still
 * being charged.
 */

let db: Database;
let close: () => Promise<void>;
let ctx: AdminContext;
let adminId: string;

async function seedClient(name: string, overrides: { isInternal?: boolean } = {}) {
  const org = (
    await db
      .insert(organizations)
      .values({ publicId: newPublicId(), name, slug: name.toLowerCase().replace(/\s+/g, "-"), kind: "client" })
      .returning()
  )[0]!;
  const client = (
    await db
      .insert(clients)
      .values({ publicId: newPublicId(), organizationId: org.id, ...overrides })
      .returning()
  )[0]!;
  return { org, client };
}

async function seedSubscription(
  clientId: string,
  values: Partial<typeof subscriptions.$inferInsert> = {},
) {
  return (
    await db
      .insert(subscriptions)
      .values({
        publicId: newPublicId(),
        clientId,
        monthlyPriceCents: 4900,
        startedOn: "2026-01-01",
        ...values,
      })
      .returning()
  )[0]!;
}

async function reload(clientId: string) {
  return (await db.select().from(clients).where(eq(clients.id, clientId)))[0]!;
}

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
});

afterAll(async () => close());

beforeEach(async () => {
  await db.delete(auditLog);
  await db.delete(payments);
  await db.delete(subscriptions);
  await db.delete(sites);
  await db.delete(clients);
  await db.delete(users);
  await db.delete(organizations);

  adminId = (
    await db
      .insert(users)
      .values({ publicId: newPublicId(), email: "admin@example.test", role: "admin", status: "active" })
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

describe("archiveClient", () => {
  it("takes the client off the Clients list and records who did it", async () => {
    const { client } = await seedClient("Gone Gallery");
    await seedClient("Stays Studio");

    const outcome = await archiveClient(ctx, db, client.publicId);

    expect(outcome).toEqual({ ok: true, name: "Gone Gallery" });
    const names = (await listClients(ctx, db)).map((c) => c.name);
    expect(names).toEqual(["Stays Studio"]);
    expect((await reload(client.id)).archivedAt).toBeInstanceOf(Date);

    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "client.archived"));
    expect(entry).toMatchObject({
      actorUserId: adminId,
      entityType: "client",
      entityId: client.publicId,
      metadata: { name: "Gone Gallery" },
    });
  });

  it("keeps their payments, plan, site and organization exactly as they were", async () => {
    const { org, client } = await seedClient("Kept Records");
    const subscription = await seedSubscription(client.id, { provider: null });
    await db.insert(payments).values({
      publicId: newPublicId(),
      clientId: client.id,
      subscriptionId: subscription.id,
      amountCents: 4900,
      method: "venmo",
      receivedOn: "2026-02-01",
    });
    await db.insert(sites).values({
      publicId: newPublicId(),
      organizationId: org.id,
      name: "Kept Records",
      primaryDomain: "kept.example",
      netlifySiteId: "netlify-site-id",
    });

    await archiveClient(ctx, db, client.publicId);

    expect(await db.select().from(payments).where(eq(payments.clientId, client.id))).toHaveLength(1);
    expect(await db.select().from(subscriptions).where(eq(subscriptions.clientId, client.id))).toEqual([
      subscription,
    ]);
    const [site] = await db.select().from(sites).where(eq(sites.organizationId, org.id));
    expect(site).toMatchObject({ primaryDomain: "kept.example", netlifySiteId: "netlify-site-id" });
    expect(site!.archivedAt).toBeNull();
    expect(await db.select().from(organizations).where(eq(organizations.id, org.id))).toHaveLength(1);
  });

  it.each([
    ["active", "active"],
    ["trialing", "active"],
    ["past_due", "active"],
    ["paused", "paused"],
  ] as const)(
    "refuses while a Stripe subscription is %s",
    async (providerStatus, status) => {
      const { client } = await seedClient("Still Billed");
      await seedSubscription(client.id, {
        provider: "stripe",
        providerSubscriptionId: "sub_live",
        providerStatus,
        status,
      });

      const outcome = await archiveClient(ctx, db, client.publicId);

      expect(outcome).toEqual({ ok: false, reason: "active_subscription" });
      expect((await reload(client.id)).archivedAt).toBeNull();
      expect(await db.select().from(auditLog)).toHaveLength(0);
    },
  );

  it("refuses a Stripe subscription that is scheduled to end but has not", async () => {
    const { client } = await seedClient("Ending Soon");
    await seedSubscription(client.id, {
      provider: "stripe",
      providerSubscriptionId: "sub_ending",
      providerStatus: "active",
      cancelAtPeriodEnd: true,
    });

    expect(await archiveClient(ctx, db, client.publicId)).toEqual({
      ok: false,
      reason: "active_subscription",
    });
  });

  it.each([
    ["canceled by Stripe", { providerStatus: "canceled", status: "cancelled" as const }],
    ["expired before the first payment", { providerStatus: "incomplete_expired", status: "cancelled" as const }],
  ])("allows removal once the Stripe subscription is %s", async (_label, ended) => {
    const { client } = await seedClient("Billing Ended");
    await seedSubscription(client.id, {
      provider: "stripe",
      providerSubscriptionId: "sub_done",
      ...ended,
    });

    expect(await archiveClient(ctx, db, client.publicId)).toEqual({ ok: true, name: "Billing Ended" });
  });

  it("is not stopped by a plan billed by hand", async () => {
    const { client } = await seedClient("Pays By Venmo");
    await seedSubscription(client.id, { provider: null });

    expect(await archiveClient(ctx, db, client.publicId)).toEqual({ ok: true, name: "Pays By Venmo" });
  });

  it("refuses the agency's own site, which the MortensenWeb tab depends on", async () => {
    const { client } = await seedClient("MortensenWeb", { isInternal: true });

    expect(await archiveClient(ctx, db, client.publicId)).toEqual({ ok: false, reason: "internal" });
    expect((await reload(client.id)).archivedAt).toBeNull();
  });

  it("says so when the client does not exist", async () => {
    expect(await archiveClient(ctx, db, "nope")).toEqual({ ok: false, reason: "not_found" });
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it("says so, and logs nothing, when the client is already removed", async () => {
    const { client } = await seedClient("Twice");
    await archiveClient(ctx, db, client.publicId);
    const firstArchivedAt = (await reload(client.id)).archivedAt;

    expect(await archiveClient(ctx, db, client.publicId)).toEqual({
      ok: false,
      reason: "already_archived",
    });
    expect((await reload(client.id)).archivedAt).toEqual(firstArchivedAt);
    expect(await db.select().from(auditLog)).toHaveLength(1);
  });
});

describe("restoreClient", () => {
  it("puts the client back on the Clients list and logs it", async () => {
    const { client } = await seedClient("Coming Back");
    await archiveClient(ctx, db, client.publicId);

    const outcome = await restoreClient(ctx, db, client.publicId);

    expect(outcome).toEqual({ ok: true, name: "Coming Back" });
    expect((await listClients(ctx, db)).map((c) => c.name)).toEqual(["Coming Back"]);
    expect((await reload(client.id)).archivedAt).toBeNull();
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "client.restored"));
    expect(entry).toMatchObject({
      actorUserId: adminId,
      entityId: client.publicId,
      metadata: { name: "Coming Back" },
    });
  });

  it("says so when the client was never removed", async () => {
    const { client } = await seedClient("Never Left");

    expect(await restoreClient(ctx, db, client.publicId)).toEqual({
      ok: false,
      reason: "not_archived",
    });
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it("says so when the client does not exist", async () => {
    expect(await restoreClient(ctx, db, "nope")).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("listArchivedClients", () => {
  it("lists removed clients, newest first, and leaves out active ones and the agency's own site", async () => {
    const first = await seedClient("First Out");
    const second = await seedClient("Second Out");
    await seedClient("Still Here");
    await seedClient("MortensenWeb", { isInternal: true });
    await archiveClient(ctx, db, first.client.publicId);
    await db
      .update(clients)
      .set({ archivedAt: new Date("2026-01-01T00:00:00Z") })
      .where(eq(clients.id, first.client.id));
    await archiveClient(ctx, db, second.client.publicId);

    const archived = await listArchivedClients(ctx, db);

    expect(archived.map((c) => c.name)).toEqual(["Second Out", "First Out"]);
    expect(archived[0]).toMatchObject({
      clientPublicId: second.client.publicId,
      archivedAt: expect.any(Date),
    });
  });
});

describe("clientsWithLiveStripeBilling", () => {
  it("returns only the clients that a Stripe subscription is still billing", async () => {
    const billed = await seedClient("Billed");
    const ended = await seedClient("Ended");
    const manual = await seedClient("Manual");
    await seedSubscription(billed.client.id, {
      provider: "stripe",
      providerSubscriptionId: "sub_1",
      providerStatus: "active",
    });
    await seedSubscription(ended.client.id, {
      provider: "stripe",
      providerSubscriptionId: "sub_2",
      providerStatus: "canceled",
      status: "cancelled",
    });
    await seedSubscription(manual.client.id, { provider: null });

    const live = await clientsWithLiveStripeBilling(db, [
      billed.client.publicId,
      ended.client.publicId,
      manual.client.publicId,
    ]);

    expect([...live]).toEqual([billed.client.publicId]);
  });

  it("returns nothing for an empty list without querying", async () => {
    expect((await clientsWithLiveStripeBilling(db, [])).size).toBe(0);
  });
});
