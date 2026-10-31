import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db/client";
import { analyticsConnections, auditLog, clients, notifications, organizations, sites, users } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * Going live keeps the Umami website a converted site already reports to.
 *
 * Conversion creates the website before there is a real domain, often under
 * the Netlify address, and puts its id in the site's pages. If go-live made a
 * second website for the real domain, the dashboard would read the new one
 * while the site kept reporting to the old: zeros for a site with visitors.
 */

const provisionWebsite = vi.fn(async () => ({ ok: true as const, websiteId: "new-website", created: true }));

vi.mock("@/lib/analytics/umami", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics/umami")>()),
  provisionWebsite: () => provisionWebsite(),
}));
vi.mock("@/lib/netlify/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/netlify/api")>()),
  verifyUrlServes: async () => ({ ok: true, status: 200 }),
}));
vi.mock("@/lib/email/mailer", () => ({ sendEmail: async () => ({ status: "sent", id: "e" }) }));

const { verifyAndGoLive } = await import("@/db/repositories/admin/launch");
const { adminContextFrom } = await import("@/db/repositories/context");

let db: Database;
let close: () => Promise<void>;
let adminId: string;

async function seedSite(websiteId: string | null) {
  const [org] = await db
    .insert(organizations)
    .values({ publicId: newPublicId(), name: "Basin View", slug: "basin-view", kind: "client" })
    .returning();
  await db.insert(clients).values({ publicId: newPublicId(), organizationId: org!.id });
  const [site] = await db
    .insert(sites)
    .values({ publicId: newPublicId(), organizationId: org!.id, name: "Basin View", primaryDomain: "basinview.com" })
    .returning();
  if (websiteId) {
    await db.insert(analyticsConnections).values({ siteId: site!.id, umamiWebsiteId: websiteId, status: "connected" });
  }
  return site!;
}

const ctx = () =>
  adminContextFrom({ userId: adminId, organizationId: null, role: "admin", status: "active", sessionEpoch: 0 });

beforeAll(async () => ({ db, close } = await createTestDb()));
afterAll(async () => close());

beforeEach(async () => {
  provisionWebsite.mockClear();
  for (const table of [auditLog, notifications, analyticsConnections, sites, clients, users, organizations]) {
    await db.delete(table);
  }
  adminId = (
    await db.insert(users).values({ publicId: newPublicId(), email: "op@example.test", role: "admin", status: "active" }).returning()
  )[0]!.id;
});

describe("verifyAndGoLive and an existing Umami website", () => {
  it("keeps the website the site already reports to", async () => {
    const site = await seedSite("from-conversion");

    const outcome = await verifyAndGoLive(ctx(), db, site.publicId);

    expect(outcome).toMatchObject({ ok: true, analyticsWebsiteId: "from-conversion" });
    expect(provisionWebsite).not.toHaveBeenCalled();
    const [connection] = await db.select().from(analyticsConnections);
    expect(connection!.umamiWebsiteId).toBe("from-conversion");
  });

  it("still provisions one for a site that has none", async () => {
    const site = await seedSite(null);

    const outcome = await verifyAndGoLive(ctx(), db, site.publicId);

    expect(outcome).toMatchObject({ ok: true, analyticsWebsiteId: "new-website" });
    expect(provisionWebsite).toHaveBeenCalledOnce();
  });
});
