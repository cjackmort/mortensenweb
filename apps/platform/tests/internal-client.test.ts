import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, clients, organizations, users } from "@/db/schema";
import { adminContextFrom, type AdminContext } from "@/db/repositories/context";
import {
  designateInternalClient,
  getInternalClient,
  listClients,
} from "@/db/repositories/admin/clients";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * Choosing which client record is the agency's own site.
 *
 * The MortensenWeb tab shows whichever client is flagged internal. The one
 * `link-internal-site.ts` created has no repository, while the record that
 * actually holds mortensenweb.com — its repository, analytics and history —
 * was added through the Clients page and so shows up as a client. Moving the
 * flag, rather than the site, keeps all of that where it is.
 */

let db: Database;
let close: () => Promise<void>;
let ctx: AdminContext;
let adminId: string;

async function seedClient(name: string, isInternal = false) {
  const org = (
    await db
      .insert(organizations)
      .values({ publicId: newPublicId(), name, slug: name.toLowerCase(), kind: "client" })
      .returning()
  )[0]!;
  return (
    await db
      .insert(clients)
      .values({ publicId: newPublicId(), organizationId: org.id, isInternal })
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

describe("designateInternalClient", () => {
  it("points the MortensenWeb tab at the chosen client", async () => {
    await seedClient("Agency", true);
    const site = await seedClient("MortensenWeb");

    const outcome = await designateInternalClient(ctx, db, site.publicId);

    expect(outcome).toMatchObject({ ok: true, changed: true });
    expect((await getInternalClient(ctx, db))?.clientPublicId).toBe(site.publicId);
  });

  it("archives the record that used to be the tab, so there is only ever one", async () => {
    const previous = await seedClient("Agency", true);
    const site = await seedClient("MortensenWeb");

    await designateInternalClient(ctx, db, site.publicId);

    const old = await reload(previous.id);
    expect(old.isInternal).toBe(false);
    expect(old.archivedAt).not.toBeNull();
    const internal = await db.select().from(clients).where(eq(clients.isInternal, true));
    expect(internal.map((c) => c.id)).toEqual([site.id]);
  });

  it("takes the chosen client out of the Clients list and leaves real clients in it", async () => {
    await seedClient("Agency", true);
    const site = await seedClient("MortensenWeb");
    const mitch = await seedClient("Mitch");

    await designateInternalClient(ctx, db, site.publicId);

    const listed = (await listClients(ctx, db)).map((c) => c.clientPublicId);
    expect(listed).toEqual([mitch.publicId]);
  });

  it("works when no record is the tab yet", async () => {
    const site = await seedClient("MortensenWeb");

    const outcome = await designateInternalClient(ctx, db, site.publicId);

    expect(outcome).toMatchObject({ ok: true, changed: true, previousClientPublicId: null });
    expect((await getInternalClient(ctx, db))?.clientPublicId).toBe(site.publicId);
  });

  it("changes nothing when the client already is the tab", async () => {
    const site = await seedClient("MortensenWeb", true);

    const outcome = await designateInternalClient(ctx, db, site.publicId);

    expect(outcome).toEqual({ ok: true, changed: false, previousClientPublicId: null });
    expect((await reload(site.id)).archivedAt).toBeNull();
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it("refuses an archived client, because the tab would then show nothing", async () => {
    const previous = await seedClient("Agency", true);
    const archived = await seedClient("Gone");
    await db.update(clients).set({ archivedAt: new Date() }).where(eq(clients.id, archived.id));

    const outcome = await designateInternalClient(ctx, db, archived.publicId);

    expect(outcome).toEqual({ ok: false, reason: "archived" });
    expect((await reload(previous.id)).isInternal).toBe(true);
  });

  it("refuses a client that does not exist", async () => {
    expect(await designateInternalClient(ctx, db, "no-such-client")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("records who moved it and from which record", async () => {
    const previous = await seedClient("Agency", true);
    const site = await seedClient("MortensenWeb");

    await designateInternalClient(ctx, db, site.publicId);

    const [entry] = await db.select().from(auditLog);
    expect(entry!.action).toBe("client.designated_internal");
    expect(entry!.actorUserId).toBe(adminId);
    expect(entry!.entityId).toBe(site.publicId);
    expect(entry!.metadata).toEqual({ previous: previous.publicId });
  });
});
