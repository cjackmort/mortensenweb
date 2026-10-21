import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, organizations, repositoryConnections, sites, users } from "@/db/schema";
import { adminContextFrom, type AdminContext } from "@/db/repositories/context";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * Connecting a self-deploying repository with a typed Netlify site name.
 *
 * Such a repository is not linked in Netlify, so detection by repository finds
 * nothing and the operator types the site's name. Only the name was stored,
 * and the leads inbox — which needs the id — refused to connect a site that
 * was hosted and serving.
 */

const getSite = vi.fn();

vi.mock("@/lib/github/app", () => ({ isGithubConfigured: () => true }));
vi.mock("@/lib/github/rest", () => ({
  getRepo: async (_installation: string, _owner: string, name: string) => ({
    node_id: `NODE_${name}`,
    name,
    default_branch: "main",
  }),
}));
vi.mock("@/lib/netlify/api", () => ({
  isNetlifyConfigured: () => true,
  findSiteByRepo: async () => null,
  getSite: (...args: unknown[]) => getSite(...args),
}));

const { connectExistingRepo } = await import("@/db/repositories/admin/connect-repo");

let db: Database;
let close: () => Promise<void>;
let ctx: AdminContext;
let orgId: string;

async function newSite() {
  return (
    await db
      .insert(sites)
      .values({ publicId: newPublicId(), organizationId: orgId, name: "site", status: "draft" })
      .returning()
  )[0]!;
}

async function siteRow(id: string) {
  return (await db.select().from(sites).where(eq(sites.id, id)))[0]!;
}

beforeAll(async () => {
  process.env.GITHUB_INSTALLATION_ID = "123";
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
});

afterAll(async () => close());

beforeEach(async () => {
  getSite.mockReset();
  await db.delete(auditLog);
  await db.delete(repositoryConnections);
  await db.delete(sites);
  await db.delete(users);
  await db.delete(organizations);

  const admin = (
    await db
      .insert(users)
      .values({ publicId: newPublicId(), email: "admin@example.test", role: "admin", status: "active" })
      .returning()
  )[0]!;
  ctx = adminContextFrom({
    userId: admin.id,
    organizationId: null,
    role: "admin",
    status: "active",
    sessionEpoch: 0,
  });

  orgId = (
    await db
      .insert(organizations)
      .values({ publicId: newPublicId(), name: "Acme", slug: "acme", kind: "client" })
      .returning()
  )[0]!.id;
});

describe("connecting with a typed Netlify site name", () => {
  it("records the site's id as well as its name", async () => {
    getSite.mockResolvedValue({ id: "site-uuid-1", name: "tipsy-talons" });
    const site = await newSite();

    const outcome = await connectExistingRepo(ctx, db, {
      sitePublicId: site.publicId,
      owner: "cjackmort",
      name: "tipsy-talons",
      previewUrlStyle: "pr_alias",
      netlifySiteName: "tipsy-talons",
    });

    expect(outcome.ok).toBe(true);
    // Looked up by default subdomain, which Netlify accepts in place of an id.
    expect(getSite).toHaveBeenCalledWith("tipsy-talons.netlify.app");
    const row = await siteRow(site.id);
    expect(row.netlifySiteId).toBe("site-uuid-1");
    expect(row.netlifySiteName).toBe("tipsy-talons");
    expect(row.previewUrlStyle).toBe("pr_alias");
  });

  it("still connects, without an id, when Netlify has no site by that name", async () => {
    getSite.mockResolvedValue(null);
    const site = await newSite();

    const outcome = await connectExistingRepo(ctx, db, {
      sitePublicId: site.publicId,
      owner: "cjackmort",
      name: "tipsy-talons",
      netlifySiteName: "no-such-site",
    });

    expect(outcome.ok).toBe(true);
    const row = await siteRow(site.id);
    expect(row.netlifySiteId).toBeNull();
    expect(row.netlifySiteName).toBe("no-such-site");
  });

  it("does not refuse the connection when Netlify cannot be reached", async () => {
    getSite.mockRejectedValue(new Error("network down"));
    const site = await newSite();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

    const outcome = await connectExistingRepo(ctx, db, {
      sitePublicId: site.publicId,
      owner: "cjackmort",
      name: "tipsy-talons",
      netlifySiteName: "tipsy-talons",
    });

    quiet.mockRestore();
    expect(outcome.ok).toBe(true);
    expect((await siteRow(site.id)).netlifySiteId).toBeNull();
  });
});
