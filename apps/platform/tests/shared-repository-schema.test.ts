import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db/client";
import { organizations, repositoryConnections, sites } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * Migration 0021: a repository may be connected to more than one site.
 *
 * The agency's own site is both the MortensenWeb tab and, for testing what a
 * client sees, an ordinary client record — two sites, one repository. Which
 * pairs may share is decided in `connectExistingRepo`; the database's job is
 * only to stop one site holding the same repository twice.
 */

let db: Database;
let close: () => Promise<void>;
let orgId: string;

async function newSite() {
  return (
    await db
      .insert(sites)
      .values({ publicId: newPublicId(), organizationId: orgId, name: "site", status: "live" })
      .returning()
  )[0]!;
}

function connection(siteId: string) {
  return {
    publicId: newPublicId(),
    siteId,
    owner: "cjackmort",
    name: "site-mortensenweb",
    repoNodeId: "R_shared",
    installationId: "123",
    defaultBranch: "main",
  };
}

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
});

afterAll(async () => close());

beforeEach(async () => {
  await db.delete(repositoryConnections);
  await db.delete(sites);
  await db.delete(organizations);
  orgId = (
    await db
      .insert(organizations)
      .values({ publicId: newPublicId(), name: "Acme", slug: "acme", kind: "client" })
      .returning()
  )[0]!.id;
});

describe("repository_connections after 0021", () => {
  it("lets two sites hold the same repository", async () => {
    const [a, b] = [await newSite(), await newSite()];

    await db.insert(repositoryConnections).values(connection(a.id));
    await db.insert(repositoryConnections).values(connection(b.id));

    expect(await db.select().from(repositoryConnections)).toHaveLength(2);
  });

  it("still refuses the same repository twice on one site", async () => {
    const site = await newSite();
    await db.insert(repositoryConnections).values(connection(site.id));

    await expect(
      db.insert(repositoryConnections).values(connection(site.id)),
    ).rejects.toThrow();
  });
});
