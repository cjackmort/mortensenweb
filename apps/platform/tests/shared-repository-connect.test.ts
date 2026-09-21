import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  auditLog,
  clients,
  organizations,
  repositoryConnections,
  sites,
  users,
} from "@/db/schema";
import { adminContextFrom, type AdminContext } from "@/db/repositories/context";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * Which sites may share a repository.
 *
 * Only the agency's own site. It is the MortensenWeb tab and, for testing what
 * a client sees, an ordinary client record as well — both on
 * cjackmort/site-mortensenweb. Two real clients sharing one repository would
 * mean either one's approval merging work into the other's site, so that stays
 * refused.
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

/** A site whose organization's client record is, or is not, the agency's own. */
async function siteFor(name: string, isInternal: boolean) {
  const org = (
    await db
      .insert(organizations)
      .values({ publicId: newPublicId(), name, slug: name.toLowerCase(), kind: "client" })
      .returning()
  )[0]!;
  await db.insert(clients).values({ publicId: newPublicId(), organizationId: org.id, isInternal });
  return (
    await db
      .insert(sites)
      .values({ publicId: newPublicId(), organizationId: org.id, name, status: "live" })
      .returning()
  )[0]!;
}

function connect(sitePublicId: string, name = "site-mortensenweb") {
  return connectExistingRepo(ctx, db, { sitePublicId, owner: "cjackmort", name });
}

function connectionsFor(siteId: string) {
  return db.select().from(repositoryConnections).where(eq(repositoryConnections.siteId, siteId));
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
  await db.delete(clients);
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
});

describe("sharing a repository with the agency's own site", () => {
  it("connects the MortensenWeb tab to a repository a client record already holds", async () => {
    const asClient = await siteFor("Me as a client", false);
    const tab = await siteFor("MortensenWeb", true);
    await connect(asClient.publicId);

    const outcome = await connect(tab.publicId);

    expect(outcome.ok).toBe(true);
    expect(await connectionsFor(asClient.id)).toHaveLength(1);
    expect(await connectionsFor(tab.id)).toHaveLength(1);
  });

  it("works the other way round too", async () => {
    const tab = await siteFor("MortensenWeb", true);
    const asClient = await siteFor("Me as a client", false);
    await connect(tab.publicId);

    const outcome = await connect(asClient.publicId);

    expect(outcome.ok).toBe(true);
    expect(await connectionsFor(asClient.id)).toHaveLength(1);
  });

  it("leaves the other site's connection alone when one of them saves it again", async () => {
    const asClient = await siteFor("Me as a client", false);
    const tab = await siteFor("MortensenWeb", true);
    await connect(asClient.publicId);
    await connect(tab.publicId);
    await db
      .update(repositoryConnections)
      .set({ allowlisted: true })
      .where(eq(repositoryConnections.siteId, asClient.id));

    await connect(tab.publicId);

    expect((await connectionsFor(asClient.id))[0]!.allowlisted).toBe(true);
    expect(await connectionsFor(tab.id)).toHaveLength(1);
  });

  it("still refuses two ordinary clients sharing a repository", async () => {
    const mitch = await siteFor("Mitch", false);
    const other = await siteFor("Other", false);
    await connect(mitch.publicId);

    const outcome = await connect(other.publicId);

    expect(outcome).toMatchObject({ ok: false, reason: "already_connected_elsewhere" });
    expect(await connectionsFor(other.id)).toHaveLength(0);
  });

  it("refuses a third, ordinary client joining a repository the agency site shares", async () => {
    const asClient = await siteFor("Me as a client", false);
    const tab = await siteFor("MortensenWeb", true);
    const stranger = await siteFor("Stranger", false);
    await connect(asClient.publicId);
    await connect(tab.publicId);

    const outcome = await connect(stranger.publicId);

    expect(outcome).toMatchObject({ ok: false, reason: "already_connected_elsewhere" });
  });
});
