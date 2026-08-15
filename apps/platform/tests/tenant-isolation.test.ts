import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  changeRequests,
  organizationMemberships,
  organizations,
  requestEvents,
  sites,
  users,
} from "@/db/schema";
import {
  AuthorizationError,
  NotFoundError,
  adminContextFrom,
  assertMutable,
  tenantContextFrom,
  type SessionLike,
} from "@/db/repositories/context";
import {
  createChangeRequest,
  findChangeRequest,
  getChangeRequestOrThrow,
  listChangeRequests,
  listClientVisibleEvents,
  listSites,
} from "@/db/repositories/client/change-requests";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * Cross-tenant isolation.
 *
 * This suite is blocking: a failure here is a data breach, not a bug.
 *
 * Two tenants (Acme and Globex) each own a site and a change request. Every
 * assertion checks that Acme's session cannot observe Globex's rows, and
 * specifically that the failure is indistinguishable from "does not exist".
 */

let db: Database;
let close: () => Promise<void>;

const acme = { orgId: "", userId: "", requestPublicId: "", sitePublicId: "" };
const globex = { orgId: "", userId: "", requestPublicId: "", sitePublicId: "" };

async function seedTenant(name: string, slug: string, email: string) {
  const orgRows = await db
    .insert(organizations)
    .values({ publicId: newPublicId(), name, slug, kind: "client" })
    .returning();
  const org = orgRows[0]!;

  const userRows = await db
    .insert(users)
    .values({
      publicId: newPublicId(),
      email,
      role: "client",
      status: "active",
      passwordHash: null,
    })
    .returning();
  const user = userRows[0]!;

  await db
    .insert(organizationMemberships)
    .values({ organizationId: org.id, userId: user.id, role: "owner" });

  const siteRows = await db
    .insert(sites)
    .values({
      publicId: newPublicId(),
      organizationId: org.id,
      name: `${name} site`,
      status: "live",
    })
    .returning();
  const site = siteRows[0]!;

  const requestRows = await db
    .insert(changeRequests)
    .values({
      publicId: newPublicId(),
      organizationId: org.id,
      siteId: site.id,
      createdByUserId: user.id,
      title: `${name} confidential request`,
      status: "submitted",
    })
    .returning();
  const request = requestRows[0]!;

  // One internal note and one client-visible note on each request.
  await db.insert(requestEvents).values([
    {
      requestId: request.id,
      actorType: "admin",
      kind: "internal_note",
      body: `${name} INTERNAL: margin and agent logs`,
      visibility: "internal",
    },
    {
      requestId: request.id,
      actorType: "system",
      kind: "submitted",
      body: `${name} visible: we received your request`,
      visibility: "client_visible",
    },
  ]);

  return {
    orgId: org.id,
    userId: user.id,
    requestPublicId: request.publicId,
    sitePublicId: site.publicId,
  };
}

function sessionFor(
  userId: string,
  organizationId: string | null,
  role: "admin" | "client" = "client",
): SessionLike {
  return { userId, organizationId, role, status: "active", sessionEpoch: 0 };
}

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;

  Object.assign(acme, await seedTenant("Acme HVAC", "acme-hvac", "a@acme.test"));
  Object.assign(
    globex,
    await seedTenant("Globex Glass", "globex-glass", "b@globex.test"),
  );
});

afterAll(async () => {
  await close();
});

describe("context construction", () => {
  it("refuses to build a tenant context for another organization", () => {
    const session = sessionFor(acme.userId, acme.orgId);
    // Acme's user reaching for Globex's organization.
    expect(() => tenantContextFrom(session, globex.orgId)).toThrow(
      NotFoundError,
    );
  });

  it("refuses any context for a disabled account", () => {
    const disabled: SessionLike = {
      ...sessionFor(acme.userId, acme.orgId),
      status: "disabled",
    };
    expect(() => tenantContextFrom(disabled, acme.orgId)).toThrow(
      AuthorizationError,
    );
    expect(() => adminContextFrom({ ...disabled, role: "admin" })).toThrow(
      AuthorizationError,
    );
  });

  it("refuses an admin context to a client", () => {
    expect(() => adminContextFrom(sessionFor(acme.userId, acme.orgId))).toThrow(
      AuthorizationError,
    );
  });

  it("lets an admin scope into any tenant (view as client)", () => {
    const admin = sessionFor("admin-id", null, "admin");
    const ctx = tenantContextFrom(admin, globex.orgId, { impersonating: true });
    expect(ctx.organizationId).toBe(globex.orgId);
    expect(ctx.impersonating).toBe(true);
  });

  it("blocks mutations while impersonating", () => {
    const admin = sessionFor("admin-id", null, "admin");
    const ctx = tenantContextFrom(admin, globex.orgId, { impersonating: true });
    expect(() => assertMutable(ctx)).toThrow(AuthorizationError);
  });
});

describe("cross-tenant reads", () => {
  it("lists only the caller's own change requests", async () => {
    const ctx = tenantContextFrom(
      sessionFor(acme.userId, acme.orgId),
      acme.orgId,
    );
    const rows = await listChangeRequests(db, ctx);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.publicId).toBe(acme.requestPublicId);
    expect(rows.map((r) => r.publicId)).not.toContain(globex.requestPublicId);
  });

  it("returns null — not a record — for another tenant's request id", async () => {
    const ctx = tenantContextFrom(
      sessionFor(acme.userId, acme.orgId),
      acme.orgId,
    );

    // The exact, valid public ID of Globex's request.
    const found = await findChangeRequest(db, ctx, globex.requestPublicId);
    expect(found).toBeNull();
  });

  it("throws NotFound — never Authorization — for another tenant's request", async () => {
    const ctx = tenantContextFrom(
      sessionFor(acme.userId, acme.orgId),
      acme.orgId,
    );

    // This is the 404-not-403 rule. An AuthorizationError here would confirm
    // to Acme that Globex's record exists, which is itself the leak.
    await expect(
      getChangeRequestOrThrow(db, ctx, globex.requestPublicId),
    ).rejects.toThrow(NotFoundError);

    await expect(
      getChangeRequestOrThrow(db, ctx, globex.requestPublicId),
    ).rejects.not.toThrow(AuthorizationError);
  });

  it("is indistinguishable from a wholly nonexistent id", async () => {
    const ctx = tenantContextFrom(
      sessionFor(acme.userId, acme.orgId),
      acme.orgId,
    );

    const foreign = await findChangeRequest(db, ctx, globex.requestPublicId);
    const nonexistent = await findChangeRequest(db, ctx, newPublicId());

    expect(foreign).toBeNull();
    expect(nonexistent).toBeNull();
    expect(foreign).toEqual(nonexistent);
  });

  it("lists only the caller's own sites", async () => {
    const ctx = tenantContextFrom(
      sessionFor(acme.userId, acme.orgId),
      acme.orgId,
    );
    const rows = await listSites(db, ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.publicId).toBe(acme.sitePublicId);
  });

  it("refuses the timeline of another tenant's request", async () => {
    const ctx = tenantContextFrom(
      sessionFor(acme.userId, acme.orgId),
      acme.orgId,
    );
    await expect(
      listClientVisibleEvents(db, ctx, globex.requestPublicId),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("internal versus client-visible", () => {
  it("never returns internal events to a client timeline", async () => {
    const ctx = tenantContextFrom(
      sessionFor(acme.userId, acme.orgId),
      acme.orgId,
    );
    const events = await listClientVisibleEvents(db, ctx, acme.requestPublicId);

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.body).not.toContain("INTERNAL");
      expect(event.kind).not.toBe("internal_note");
    }
  });

  it("confirms internal rows do exist — the filter is doing the work", async () => {
    // Guards against a false pass: if the seed had written no internal rows,
    // the assertion above would succeed for the wrong reason.
    const all = await db
      .select()
      .from(requestEvents)
      .where(eq(requestEvents.visibility, "internal"));
    expect(all.length).toBeGreaterThanOrEqual(2);
  });
});

describe("cross-tenant writes", () => {
  it("refuses to attach a new request to another tenant's site", async () => {
    const ctx = tenantContextFrom(
      sessionFor(acme.userId, acme.orgId),
      acme.orgId,
    );

    await expect(
      createChangeRequest(db, ctx, {
        title: "Trying to attach to Globex",
        sitePublicId: globex.sitePublicId,
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it("stamps a created request with the caller's own organization", async () => {
    const ctx = tenantContextFrom(
      sessionFor(acme.userId, acme.orgId),
      acme.orgId,
    );

    const created = await createChangeRequest(db, ctx, {
      title: "Update the hero headline",
      sitePublicId: acme.sitePublicId,
      category: "content",
    });

    expect(created.organizationId).toBe(acme.orgId);
    expect(created.organizationId).not.toBe(globex.orgId);

    // And Globex still cannot see it.
    const globexCtx = tenantContextFrom(
      sessionFor(globex.userId, globex.orgId),
      globex.orgId,
    );
    await expect(
      findChangeRequest(db, globexCtx, created.publicId),
    ).resolves.toBeNull();
  });
});
