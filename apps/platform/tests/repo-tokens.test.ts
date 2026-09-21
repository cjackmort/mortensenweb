import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db/client";
import {
  auditLog,
  organizations,
  repositoryConnections,
  sites,
  users,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * Installing the portal's tokens into a connected repository.
 *
 * The portal holds CLAUDE_CODE_OAUTH_TOKEN and NETLIFY_AUTH_TOKEN in its own
 * environment and used to write them only into repositories it scaffolded. A
 * repository connected in place got nothing, so its agent and deploy workflows
 * failed until someone pasted both tokens in by hand — per repository, and
 * again whenever a token was replaced.
 *
 * GitHub is mocked at the sealing boundary: what matters here is which
 * repository is written to, and that nothing is written when there is no
 * repository to write to.
 */

const provisionRepoSecrets = vi.fn();
vi.mock("@/lib/github/secrets", () => ({
  provisionRepoSecrets: (...args: unknown[]) => provisionRepoSecrets(...args),
}));

const { installRepoTokens, describeTokenInstall } = await import(
  "@/db/repositories/admin/repo-tokens"
);

let db: Database;
let close: () => Promise<void>;
let orgId: string;
let adminId: string;

async function seedSite(
  repo: { owner: string; name: string; installationId?: string | null } | null,
) {
  const site = (
    await db
      .insert(sites)
      .values({ publicId: newPublicId(), organizationId: orgId, name: "site", status: "live" })
      .returning()
  )[0]!;

  if (repo) {
    await db.insert(repositoryConnections).values({
      publicId: newPublicId(),
      siteId: site.id,
      owner: repo.owner,
      name: repo.name,
      repoNodeId: `R_${Math.random().toString(36).slice(2, 12)}`,
      installationId: repo.installationId === undefined ? "12345" : repo.installationId,
      defaultBranch: "main",
    });
  }

  return site;
}

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
});

afterAll(async () => close());

beforeEach(async () => {
  provisionRepoSecrets.mockReset();
  provisionRepoSecrets.mockResolvedValue({
    written: ["CLAUDE_CODE_OAUTH_TOKEN", "NETLIFY_AUTH_TOKEN"],
    missing: [],
    failed: [],
  });

  await db.delete(auditLog);
  await db.delete(repositoryConnections);
  await db.delete(sites);
  await db.delete(users);
  await db.delete(organizations);

  adminId = (
    await db
      .insert(users)
      .values({ publicId: newPublicId(), email: "admin@example.test", role: "admin", status: "active" })
      .returning()
  )[0]!.id;

  orgId = (
    await db
      .insert(organizations)
      .values({ publicId: newPublicId(), name: "Acme", slug: "acme", kind: "client" })
      .returning()
  )[0]!.id;
});

describe("installRepoTokens", () => {
  it("writes the tokens into the repository connected to that site", async () => {
    const site = await seedSite({ owner: "cjackmort", name: "site-acme" });

    const outcome = await installRepoTokens(db, adminId, site.publicId);

    expect(provisionRepoSecrets).toHaveBeenCalledTimes(1);
    expect(provisionRepoSecrets).toHaveBeenCalledWith({
      installationId: "12345",
      owner: "cjackmort",
      name: "site-acme",
    });
    expect(outcome).toEqual({
      ok: true,
      repository: "cjackmort/site-acme",
      written: ["CLAUDE_CODE_OAUTH_TOKEN", "NETLIFY_AUTH_TOKEN"],
      missing: [],
      failed: [],
    });
  });

  it("writes nothing when the site has no repository", async () => {
    const site = await seedSite(null);

    const outcome = await installRepoTokens(db, adminId, site.publicId);

    expect(provisionRepoSecrets).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ok: false, reason: "no_repository" });
  });

  it("uses the portal's installation when the connection recorded none", async () => {
    const previous = process.env.GITHUB_INSTALLATION_ID;
    process.env.GITHUB_INSTALLATION_ID = "999";
    try {
      const site = await seedSite({ owner: "cjackmort", name: "site-acme", installationId: null });
      await installRepoTokens(db, adminId, site.publicId);
      expect(provisionRepoSecrets).toHaveBeenCalledWith({
        installationId: "999",
        owner: "cjackmort",
        name: "site-acme",
      });
    } finally {
      if (previous === undefined) delete process.env.GITHUB_INSTALLATION_ID;
      else process.env.GITHUB_INSTALLATION_ID = previous;
    }
  });

  it("writes nothing when there is no GitHub installation to write with", async () => {
    const previous = process.env.GITHUB_INSTALLATION_ID;
    delete process.env.GITHUB_INSTALLATION_ID;
    try {
      const site = await seedSite({ owner: "cjackmort", name: "site-acme", installationId: null });
      const outcome = await installRepoTokens(db, adminId, site.publicId);
      expect(provisionRepoSecrets).not.toHaveBeenCalled();
      expect(outcome).toEqual({ ok: false, reason: "not_configured" });
    } finally {
      if (previous !== undefined) process.env.GITHUB_INSTALLATION_ID = previous;
    }
  });

  it("writes nothing for a site that does not exist", async () => {
    const outcome = await installRepoTokens(db, adminId, "no-such-site");

    expect(provisionRepoSecrets).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ok: false, reason: "site_not_found" });
  });

  it("records who installed them and which names landed, never the values", async () => {
    const site = await seedSite({ owner: "cjackmort", name: "site-acme" });

    await installRepoTokens(db, adminId, site.publicId);

    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("repository.tokens_installed");
    expect(rows[0]!.actorUserId).toBe(adminId);
    expect(rows[0]!.metadata).toEqual({
      repository: "cjackmort/site-acme",
      written: ["CLAUDE_CODE_OAUTH_TOKEN", "NETLIFY_AUTH_TOKEN"],
      missing: [],
      failed: [],
    });
  });
});

describe("describeTokenInstall", () => {
  it("says what was installed", () => {
    expect(
      describeTokenInstall({
        ok: true,
        repository: "cjackmort/site-acme",
        written: ["CLAUDE_CODE_OAUTH_TOKEN", "NETLIFY_AUTH_TOKEN"],
        missing: [],
        failed: [],
      }),
    ).toEqual({
      ok: true,
      message: "Installed CLAUDE_CODE_OAUTH_TOKEN and NETLIFY_AUTH_TOKEN in cjackmort/site-acme.",
    });
  });

  it("names a token the portal does not have, so the operator knows where to add it", () => {
    const result = describeTokenInstall({
      ok: true,
      repository: "cjackmort/site-acme",
      written: ["CLAUDE_CODE_OAUTH_TOKEN"],
      missing: ["NETLIFY_AUTH_TOKEN"],
      failed: [],
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("NETLIFY_AUTH_TOKEN is not set in the portal's environment");
  });

  it("names a token that failed to write", () => {
    const result = describeTokenInstall({
      ok: true,
      repository: "cjackmort/site-acme",
      written: [],
      missing: [],
      failed: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", reason: "403" }],
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Could not write CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("explains a site with no repository", () => {
    expect(describeTokenInstall({ ok: false, reason: "no_repository" })).toEqual({
      ok: false,
      message: "Connect a repository first. There is nowhere to install the tokens.",
    });
  });
});
