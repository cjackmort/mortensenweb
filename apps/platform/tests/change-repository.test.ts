import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  auditLog,
  organizations,
  repositoryConnections,
  sites,
  users,
} from "@/db/schema";
import { adminContextFrom, type AdminContext } from "@/db/repositories/context";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * "Change the repository" on the admin site panel.
 *
 * The form pre-fills the current repository and says it changes it, but
 * connecting looked a connection up by the new repository's node id, found
 * none, and inserted a second one beside the first. The site then had two
 * repositories: allowing work allowed both, and anything reading "the"
 * connection took whichever row came back first. Moving mortensenweb.com to
 * its own repository is the case that surfaced it.
 */

vi.mock("@/lib/github/app", () => ({ isGithubConfigured: () => true }));
vi.mock("@/lib/github/rest", () => ({
  getRepo: async (_installation: string, _owner: string, name: string) => ({
    node_id: `NODE_${name}`,
    name,
    default_branch: "main",
  }),
}));
vi.mock("@/lib/netlify/api", () => ({
  isNetlifyConfigured: () => false,
  findSiteByRepo: async () => null,
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
      .values({ publicId: newPublicId(), organizationId: orgId, name: "site", status: "live" })
      .returning()
  )[0]!;
}

function connect(sitePublicId: string, name: string) {
  return connectExistingRepo(ctx, db, { sitePublicId, owner: "cjackmort", name });
}

function connectionsFor(siteId: string) {
  return db
    .select()
    .from(repositoryConnections)
    .where(eq(repositoryConnections.siteId, siteId));
}

beforeAll(async () => {
  process.env.GITHUB_INSTALLATION_ID = "123";
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
});

afterAll(async () => close());

beforeEach(async () => {
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

describe("changing a site's repository", () => {
  it("replaces the connection instead of adding a second one", async () => {
    const site = await newSite();
    await connect(site.publicId, "mortensenweb");

    const outcome = await connect(site.publicId, "site-mortensenweb");

    expect(outcome.ok).toBe(true);
    const rows = await connectionsFor(site.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("site-mortensenweb");
    expect(rows[0]!.repoNodeId).toBe("NODE_site-mortensenweb");
  });

  it("switches automated work off, because the new repository was never allowed", async () => {
    const site = await newSite();
    await connect(site.publicId, "mortensenweb");
    await db.update(repositoryConnections).set({ allowlisted: true });

    await connect(site.publicId, "site-mortensenweb");

    const rows = await connectionsFor(site.id);
    expect(rows[0]!.allowlisted).toBe(false);
  });

  it("records the change, naming both repositories", async () => {
    const site = await newSite();
    await connect(site.publicId, "mortensenweb");
    await db.delete(auditLog);

    await connect(site.publicId, "site-mortensenweb");

    const [entry] = await db.select().from(auditLog);
    expect(entry!.action).toBe("repository.replaced");
    expect(entry!.metadata).toMatchObject({
      repository: "cjackmort/site-mortensenweb",
      replaced: "cjackmort/mortensenweb",
    });
  });

  it("keeps automated work as it was when the same repository is saved again", async () => {
    const site = await newSite();
    await connect(site.publicId, "site-mortensenweb");
    await db.update(repositoryConnections).set({ allowlisted: true });

    await connect(site.publicId, "site-mortensenweb");

    const rows = await connectionsFor(site.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.allowlisted).toBe(true);
  });

  it("still refuses a repository that belongs to a different site", async () => {
    const first = await newSite();
    const second = await newSite();
    await connect(first.publicId, "site-mortensenweb");

    const outcome = await connect(second.publicId, "site-mortensenweb");

    expect(outcome).toMatchObject({ ok: false, reason: "already_connected_elsewhere" });
    expect(await connectionsFor(second.id)).toHaveLength(0);
  });
});
