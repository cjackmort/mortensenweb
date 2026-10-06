import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
 * Every site's repository runs the same agent workflow, whatever built it.
 *
 * The only thing that used to put an agent workflow into a repository was the
 * GitHub template it was generated from. Sites connected in place had none —
 * a request opened an issue and nothing ran — and a site generated from an
 * older template kept that template's prompt, model and triggers for ever.
 *
 * GitHub is mocked at the request boundary, so the real contents-API code and
 * its base64 handling run.
 */

type Call = { method: string; path: string; body?: { content?: string; sha?: string; branch?: string; message?: string } };
const calls: Call[] = [];
let existingFile: { sha: string; text: string } | null = null;

function encode(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decode(base64: string): string {
  const binary = atob(base64);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

vi.mock("@/lib/github/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/github/app")>();
  return {
    ...actual,
    githubRequest: async (_installation: string, path: string, options: { method?: string; body?: Call["body"] } = {}) => {
      const method = options.method ?? "GET";
      calls.push({ method, path, body: options.body });
      if (method === "GET") {
        if (!existingFile) return { status: 404, data: {} };
        // GitHub wraps base64 at 60 columns; the reader must cope.
        const wrapped = encode(existingFile.text).replace(/(.{60})/g, "$1\n");
        return { status: 200, data: { sha: existingFile.sha, content: wrapped } };
      }
      return { status: 201, data: {} };
    },
  };
});

const { installAgentWorkflow, describeWorkflowInstall } = await import(
  "@/db/repositories/admin/repo-tokens"
);
const { AGENT_CALLER_WORKFLOW } = await import("@/lib/github/agent-workflow");

let db: Database;
let close: () => Promise<void>;
let orgId: string;
let adminId: string;

async function seedSite(withRepo: boolean) {
  const site = (
    await db
      .insert(sites)
      .values({ publicId: newPublicId(), organizationId: orgId, name: "site", status: "live" })
      .returning()
  )[0]!;

  if (withRepo) {
    await db.insert(repositoryConnections).values({
      publicId: newPublicId(),
      siteId: site.id,
      owner: "cjackmort",
      name: "site-acme",
      repoNodeId: `R_${Math.random().toString(36).slice(2, 12)}`,
      installationId: "12345",
      defaultBranch: "master",
    });
  }
  return site;
}

function writes() {
  return calls.filter((c) => c.method === "PUT");
}

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
});

afterAll(async () => close());

beforeEach(async () => {
  calls.length = 0;
  existingFile = null;
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

describe("installAgentWorkflow", () => {
  it("installs the caller on the default branch of a repository that has none", async () => {
    const site = await seedSite(true);

    const outcome = await installAgentWorkflow(db, adminId, site.publicId);

    expect(outcome).toEqual({ ok: true, repository: "cjackmort/site-acme", result: "installed" });
    const [put] = writes();
    expect(put!.path).toBe("/repos/cjackmort/site-acme/contents/.github/workflows/claude.yml");
    expect(put!.body!.branch).toBe("master");
    expect(put!.body!.sha).toBeUndefined();
    expect(decode(put!.body!.content!)).toBe(AGENT_CALLER_WORKFLOW);
    // Changes nothing a visitor sees, so it must not redeploy production.
    expect(put!.body!.message).toContain("[skip ci]");
  });

  it("replaces a repository's own older copy", async () => {
    existingFile = { sha: "old-blob", text: "on:\n  issues:\n    types: [opened, labeled]\n" };
    const site = await seedSite(true);

    const outcome = await installAgentWorkflow(db, adminId, site.publicId);

    expect(outcome).toMatchObject({ ok: true, result: "replaced" });
    expect(writes()[0]!.body!.sha).toBe("old-blob");
  });

  it("writes nothing when the repository already has this caller", async () => {
    existingFile = { sha: "same-blob", text: AGENT_CALLER_WORKFLOW };
    const site = await seedSite(true);

    const outcome = await installAgentWorkflow(db, adminId, site.publicId);

    expect(outcome).toMatchObject({ ok: true, result: "current" });
    expect(writes()).toHaveLength(0);
  });

  it("writes nothing when the site has no repository", async () => {
    const site = await seedSite(false);

    const outcome = await installAgentWorkflow(db, adminId, site.publicId);

    expect(outcome).toEqual({ ok: false, reason: "no_repository" });
    expect(calls).toHaveLength(0);
  });

  it("records what it did in the audit log", async () => {
    const site = await seedSite(true);

    await installAgentWorkflow(db, adminId, site.publicId);

    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("repository.agent_workflow_installed");
    expect(rows[0]!.metadata).toEqual({ repository: "cjackmort/site-acme", result: "installed" });
  });
});

describe("the caller the portal installs", () => {
  it("is the template file, character for character", () => {
    const template = readFileSync(
      resolve(process.cwd(), "../../templates/client-repo/.github/workflows/claude.yml"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    expect(AGENT_CALLER_WORKFLOW).toBe(template);
  });

  it("runs once per issue and calls the shared workflow in the public agent repository", () => {
    // Private client repositories cannot call a workflow in a private one.
    expect(AGENT_CALLER_WORKFLOW).toContain(
      "uses: cjackmort/mortensenweb-agent/.github/workflows/client-change.yml@main",
    );
    expect(AGENT_CALLER_WORKFLOW).toContain("types: [labeled]");
    expect(AGENT_CALLER_WORKFLOW).toContain("if: github.event.label.name == 'claude'");
    expect(AGENT_CALLER_WORKFLOW).toContain("secrets: inherit");
  });
});

describe("describeWorkflowInstall", () => {
  it("says what happened in the operator's terms", () => {
    expect(describeWorkflowInstall({ ok: true, repository: "o/r", result: "installed" }).message).toMatch(/Installed the agent workflow/);
    expect(describeWorkflowInstall({ ok: true, repository: "o/r", result: "replaced" }).message).toMatch(/Replaced/);
    expect(describeWorkflowInstall({ ok: true, repository: "o/r", result: "current" }).message).toMatch(/already/);
    expect(describeWorkflowInstall({ ok: false, reason: "no_repository" }).ok).toBe(false);
  });
});
