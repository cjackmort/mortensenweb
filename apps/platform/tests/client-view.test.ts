import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { clients, impersonationSessions, organizations, users } from "@/db/schema";
import {
  adminContextFrom,
  NotFoundError,
  tenantContextFrom,
  type AdminContext,
} from "@/db/repositories/context";
import {
  CLIENT_VIEW_MAX_HOURS,
  endClientView,
  findClientView,
  startClientView,
} from "@/db/repositories/admin/client-view";
import { resolveClientView } from "@/lib/auth/client-view";
import { clientViewCookieName } from "@/lib/auth/cookie-name";
import type { AuthenticatedUser } from "@/lib/auth/session";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * "Switch to MortensenWeb": the operator using the portal as the agency's own
 * client, so the client pages and forms can be tried the way a client meets
 * them.
 *
 * The switch narrows an admin session to one organization — the internal
 * client — and nothing else. It never reaches a paying client's data, it ends
 * when the operator switches back, and it stops on its own when the record
 * stops being the internal client.
 */

let db: Database;
let close: () => Promise<void>;
let admin: AuthenticatedUser;
let ctx: AdminContext;

const HOUR = 60 * 60 * 1000;

async function seedClient(name: string, options: { isInternal?: boolean; archived?: boolean } = {}) {
  const org = (
    await db
      .insert(organizations)
      .values({ publicId: newPublicId(), name, slug: name.toLowerCase(), kind: "client" })
      .returning()
  )[0]!;
  await db.insert(clients).values({
    publicId: newPublicId(),
    organizationId: org.id,
    isInternal: options.isInternal ?? false,
    archivedAt: options.archived ? new Date() : null,
  });
  return org;
}

async function seedAdmin(email: string): Promise<AuthenticatedUser> {
  const row = (
    await db
      .insert(users)
      .values({ publicId: newPublicId(), email, role: "admin", status: "active" })
      .returning()
  )[0]!;
  return {
    userId: row.id,
    email: row.email,
    name: null,
    role: "admin",
    status: "active",
    sessionEpoch: row.sessionEpoch,
    mustChangePassword: false,
    organizationId: null,
  };
}

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
});

afterAll(async () => close());

beforeEach(async () => {
  admin = await seedAdmin("admin@example.test");
  ctx = adminContextFrom(admin);
});

afterEach(async () => {
  await db.delete(impersonationSessions);
  await db.delete(clients);
  await db.delete(users);
  await db.delete(organizations);
});

describe("startClientView", () => {
  it("returns null when no client is marked as the agency's own", async () => {
    await seedClient("Northwind");

    expect(await startClientView(ctx, db)).toBeNull();
    expect(await db.select().from(impersonationSessions)).toHaveLength(0);
  });

  it("opens a recorded session on the internal client's organization", async () => {
    await seedClient("Northwind");
    const agency = await seedClient("MortensenWeb", { isInternal: true });

    const view = await startClientView(ctx, db, { ipHash: "abc123" });

    expect(view).toMatchObject({ organizationId: agency.id, organizationName: "MortensenWeb" });
    const [row] = await db.select().from(impersonationSessions);
    expect(row).toMatchObject({
      publicId: view!.sessionPublicId,
      adminUserId: admin.userId,
      targetOrganizationId: agency.id,
      ipHash: "abc123",
      endedAt: null,
    });
  });

  it("ignores an archived internal record", async () => {
    await seedClient("Old agency record", { isInternal: true, archived: true });

    expect(await startClientView(ctx, db)).toBeNull();
  });
});

describe("findClientView", () => {
  it("finds an open session for the admin who started it", async () => {
    const agency = await seedClient("MortensenWeb", { isInternal: true });
    const view = (await startClientView(ctx, db))!;

    expect(await findClientView(ctx, db, view.sessionPublicId)).toEqual(view);
    expect((await findClientView(ctx, db, view.sessionPublicId.toLowerCase()))?.organizationId).toBe(
      agency.id,
    );
  });

  it("refuses a session another admin started", async () => {
    await seedClient("MortensenWeb", { isInternal: true });
    const view = (await startClientView(ctx, db))!;
    const other = adminContextFrom(await seedAdmin("other@example.test"));

    expect(await findClientView(other, db, view.sessionPublicId)).toBeNull();
  });

  it("refuses a session that has been ended", async () => {
    await seedClient("MortensenWeb", { isInternal: true });
    const view = (await startClientView(ctx, db))!;

    await endClientView(ctx, db, view.sessionPublicId);

    expect(await findClientView(ctx, db, view.sessionPublicId)).toBeNull();
    const [row] = await db.select().from(impersonationSessions);
    expect(row!.endedAt).toBeInstanceOf(Date);
  });

  it(`refuses a session older than ${CLIENT_VIEW_MAX_HOURS} hours`, async () => {
    await seedClient("MortensenWeb", { isInternal: true });
    const view = (await startClientView(ctx, db))!;
    const later = new Date(Date.now() + CLIENT_VIEW_MAX_HOURS * HOUR + 60_000);

    expect(await findClientView(ctx, db, view.sessionPublicId, later)).toBeNull();
  });

  it("stops working once the organization is no longer the internal client", async () => {
    const agency = await seedClient("MortensenWeb", { isInternal: true });
    const view = (await startClientView(ctx, db))!;

    await db.update(clients).set({ isInternal: false }).where(eq(clients.organizationId, agency.id));

    expect(await findClientView(ctx, db, view.sessionPublicId)).toBeNull();
  });

  it("returns null for a value that is not a public id", async () => {
    expect(await findClientView(ctx, db, "not-an-id")).toBeNull();
    expect(await findClientView(ctx, db, "")).toBeNull();
  });
});

describe("endClientView", () => {
  it("leaves another admin's session open", async () => {
    await seedClient("MortensenWeb", { isInternal: true });
    const view = (await startClientView(ctx, db))!;
    const other = adminContextFrom(await seedAdmin("other@example.test"));

    await endClientView(other, db, view.sessionPublicId);

    expect(await findClientView(ctx, db, view.sessionPublicId)).not.toBeNull();
  });
});

describe("clientViewCookieName", () => {
  const original = process.env.NODE_ENV;
  const setNodeEnv = (value: string | undefined) => {
    (process.env as Record<string, string | undefined>).NODE_ENV = value;
  };
  afterEach(() => setNodeEnv(original));

  it("carries the __Secure- prefix in production", () => {
    setNodeEnv("production");
    expect(clientViewCookieName()).toBe("__Secure-mw.client-view");
  });

  it("has no prefix in development, where the portal runs over plain HTTP", () => {
    setNodeEnv("development");
    expect(clientViewCookieName()).toMatch(/^mw\.client-view/);
  });
});

describe("resolveClientView", () => {
  it("turns the admin into a client of the internal organization", async () => {
    const agency = await seedClient("MortensenWeb", { isInternal: true });
    const view = (await startClientView(ctx, db))!;

    const user = await resolveClientView(db, admin, view.sessionPublicId);

    expect(user).toMatchObject({
      userId: admin.userId,
      email: admin.email,
      role: "client",
      organizationId: agency.id,
      viewingAs: { organizationName: "MortensenWeb", sessionPublicId: view.sessionPublicId },
    });
  });

  it("gives a tenant context that can write to the agency's own organization only", async () => {
    const agency = await seedClient("MortensenWeb", { isInternal: true });
    const paying = await seedClient("Northwind");
    const view = (await startClientView(ctx, db))!;
    const user = await resolveClientView(db, admin, view.sessionPublicId);

    const tenant = tenantContextFrom(user, agency.id);

    expect(tenant.impersonating).toBe(false);
    expect(() => tenantContextFrom(user, paying.id)).toThrow(NotFoundError);
  });

  it("leaves the admin as they are when the session does not resolve", async () => {
    await seedClient("MortensenWeb", { isInternal: true });

    expect(await resolveClientView(db, admin, newPublicId())).toBe(admin);
    expect(await resolveClientView(db, admin, undefined)).toBe(admin);
  });

  it("never applies to a client account", async () => {
    await seedClient("MortensenWeb", { isInternal: true });
    const view = (await startClientView(ctx, db))!;
    const client: AuthenticatedUser = { ...admin, role: "client", organizationId: null };

    expect(await resolveClientView(db, client, view.sessionPublicId)).toBe(client);
  });
});
