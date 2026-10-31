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
import { sha256Hex } from "@/lib/auth/password";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import type { createGithubFake } from "./helpers/github-fake";

/**
 * `POST /api/operator/clients/:id/repository` through its route handler: what
 * it refuses, what it records, and that it does what admin → Website →
 * "Connect a repository" does and nothing beyond it.
 *
 * Its own file because the operator API's per-minute call limit is held in
 * memory for the life of a test file, and `operator-api.test.ts` already spends
 * most of it. GitHub and Netlify are mocked at their boundaries; the database
 * is real, so the audit rows and the system actor are the ones production
 * would write.
 */

const TOKEN = "op_test_8f0c2b9a6d4e1f3a5c7b9d0e2f4a6c8b0d2e4f6a";
const REPOSITORY = "cjackmort/site-hair-by-graci";

type GitLink = Awaited<ReturnType<typeof import("@/lib/netlify/api").getSiteGitLink>>;

let db: Database;
let close: () => Promise<void>;
const github: { fake: ReturnType<typeof createGithubFake> | null } = { fake: null };
/** What Netlify says. */
const netlify: {
  linkedToRepo: null | { id: string; name: string; url: string; repoPath: string; branch: string | null };
  named: null | { id: string; name: string };
  gitLink: GitLink;
} = { linkedToRepo: null, named: null, gitLink: { status: "unlinked" } };

vi.mock("@/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db/client")>()),
  getDb: async () => db,
}));

vi.mock("@/lib/github/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/github/app")>();
  const { createGithubFake } = await import("./helpers/github-fake");
  github.fake = createGithubFake(actual.GithubApiError);
  return {
    ...actual,
    isGithubConfigured: () => true,
    githubRequest: (...args: Parameters<typeof actual.githubRequest>) =>
      github.fake!.request(...(args as [string, string, never])),
  };
});

vi.mock("@/lib/netlify/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/netlify/api")>()),
  isNetlifyConfigured: () => true,
  findSiteByRepo: async () => netlify.linkedToRepo,
  getSite: async () => netlify.named,
  getSiteGitLink: async () => netlify.gitLink,
}));

const route = await import("@/app/api/operator/clients/[publicId]/repository/route");
const { ensureOperatorActor, OPERATOR_API_ACTOR_EMAIL } = await import(
  "@/db/repositories/admin/operator-actor"
);

const path = (clientId: string) => `/api/operator/clients/${clientId}/repository`;
const params = (publicId: string) => ({ params: Promise.resolve({ publicId }) });

function call(clientId: string, body: unknown, { token = TOKEN }: { token?: string | null } = {}): Request {
  return new Request(`https://portal.example.test${path(clientId)}`, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "x-forwarded-for": "203.0.113.5",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const connect = (clientId: string, body: unknown) => route.POST(call(clientId, body), params(clientId));

async function operatorCalls() {
  return db.select().from(auditLog).where(eq(auditLog.action, "operator_api.call"));
}

async function seedClient({ siteCount = 1, archived = false } = {}) {
  const [org] = await db
    .insert(organizations)
    .values({ publicId: newPublicId(), name: "Hair by Graci", slug: `graci-${newPublicId().toLowerCase()}`, kind: "client" })
    .returning();
  const [client] = await db
    .insert(clients)
    .values({ publicId: newPublicId(), organizationId: org!.id, archivedAt: archived ? new Date() : null })
    .returning();
  const siteRows = [];
  for (let i = 0; i < siteCount; i += 1) {
    const [site] = await db
      .insert(sites)
      .values({ publicId: newPublicId(), organizationId: org!.id, name: `Hair by Graci ${i + 1}`, status: "live" })
      .returning();
    siteRows.push(site!);
  }
  return { clientId: client!.publicId, sitePublicId: siteRows[0]?.publicId, siteRows };
}

/** The repository exists, as far as the GitHub App can tell. */
const existingRepo = () => github.fake!.seedFile(REPOSITORY, "main", "README.md", "# site\n");

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  process.env.GITHUB_INSTALLATION_ID = "123";
});

afterAll(async () => close());

beforeEach(async () => {
  process.env.OPERATOR_API_TOKEN_SHA256 = await sha256Hex(TOKEN);
  github.fake?.reset();
  netlify.linkedToRepo = null;
  netlify.named = null;
  netlify.gitLink = { status: "unlinked" };
  for (const table of [auditLog, repositoryConnections, sites, clients, users, organizations]) {
    await db.delete(table);
  }
});

describe("POST /api/operator/clients/:id/repository", () => {
  it("answers 401 without a token and touches nothing", async () => {
    const { clientId } = await seedClient();
    existingRepo();
    github.fake!.state.calls.length = 0;

    const response = await route.POST(call(clientId, { repo: REPOSITORY }, { token: null }), params(clientId));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(await db.select().from(repositoryConnections)).toHaveLength(0);
    expect(await db.select().from(auditLog)).toHaveLength(0);
    expect(github.fake!.state.calls).toHaveLength(0);
  });

  it.each([
    ["an unknown field", { repo: REPOSITORY, repoo: "x/y" }],
    ["no repository", {}],
    ["a repository with no owner", { repo: "site-hair-by-graci" }],
    ["a pasted URL", { repo: `https://github.com/${REPOSITORY}` }],
    ["a repository name that climbs out of the path", { repo: "cjackmort/.." }],
    ["a Netlify address where its name belongs", { repo: REPOSITORY, netlifySiteName: "hair-by-graci.netlify.app" }],
    ["an empty Netlify name", { repo: REPOSITORY, netlifySiteName: "" }],
    ["an allowlist flag it does not take", { repo: REPOSITORY, allowlisted: true }],
  ])("answers 400 for %s and connects nothing", async (_label, body) => {
    const { clientId } = await seedClient();
    existingRepo();
    github.fake!.state.calls.length = 0;

    const response = await connect(clientId, body);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request");
    expect(await db.select().from(repositoryConnections)).toHaveLength(0);
    expect(github.fake!.state.calls).toHaveLength(0);
    const [logged] = await operatorCalls();
    expect(logged!.metadata).toMatchObject({ call: "clients.repository.connect", status: 400, outcome: "invalid_request" });
  });

  it("connects the client's site to a repository Netlify builds from Git", async () => {
    const { clientId, sitePublicId } = await seedClient();
    existingRepo();
    netlify.named = { id: "nf-graci", name: "hair-by-graci" };
    netlify.gitLink = { status: "linked", repoUrl: `https://github.com/${REPOSITORY}`, repoPath: REPOSITORY, branch: "main" };

    const response = await connect(clientId, { repo: REPOSITORY, netlifySiteName: "hair-by-graci" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      clientId,
      sitePublicId,
      repository: REPOSITORY,
      defaultBranch: "main",
      alreadyConnected: false,
      netlifySiteName: "hair-by-graci",
      previewUrlStyle: "deploy_preview",
      allowlisted: false,
      warnings: [],
      requestId: expect.any(String),
    });

    const [connection] = await db.select().from(repositoryConnections);
    expect(connection).toMatchObject({
      owner: "cjackmort",
      name: "site-hair-by-graci",
      connectionMode: "connected_existing",
      defaultBranch: "main",
      installationId: "123",
      allowlisted: false,
    });
    const [site] = await db.select().from(sites).where(eq(sites.publicId, sitePublicId!));
    expect(site).toMatchObject({ netlifySiteId: "nf-graci", netlifySiteName: "hair-by-graci", previewUrlStyle: "deploy_preview" });

    // It only read from GitHub: no workflow, secret or variable went in.
    expect(github.fake!.writes()).toHaveLength(0);

    const [actor] = await db.select().from(users).where(eq(users.email, OPERATOR_API_ACTOR_EMAIL));
    const [connected] = await db.select().from(auditLog).where(eq(auditLog.action, "repository.connected"));
    expect(connected).toMatchObject({ actorUserId: actor!.id, entityId: sitePublicId });
    const [logged] = await operatorCalls();
    expect(logged).toMatchObject({ entityType: "client", entityId: clientId });
    expect(logged!.metadata).toMatchObject({
      via: "operator-api",
      call: "clients.repository.connect",
      method: "POST",
      path: path(clientId),
      status: 200,
      outcome: "ok",
      requestId: body.requestId,
    });
  });

  it("finds the Netlify site from the repository when no name is given", async () => {
    const { clientId, sitePublicId } = await seedClient();
    existingRepo();
    netlify.linkedToRepo = { id: "nf-graci", name: "hair-by-graci", url: "https://hair-by-graci.netlify.app", repoPath: REPOSITORY, branch: "main" };

    const body = await (await connect(clientId, { repo: REPOSITORY })).json();

    expect(body).toMatchObject({ netlifySiteName: "hair-by-graci", previewUrlStyle: "deploy_preview" });
    const [site] = await db.select().from(sites).where(eq(sites.publicId, sitePublicId!));
    expect(site).toMatchObject({ netlifySiteId: "nf-graci", netlifySiteName: "hair-by-graci" });
  });

  it("gives a self-deploying site, which Netlify does not build, the repository's own previews", async () => {
    const { clientId } = await seedClient();
    existingRepo();
    netlify.named = { id: "nf-own", name: "own-site" };
    netlify.gitLink = { status: "unlinked" };

    const body = await (await connect(clientId, { repo: REPOSITORY, netlifySiteName: "own-site" })).json();

    expect(body).toMatchObject({ netlifySiteName: "own-site", previewUrlStyle: "pr_alias" });
  });

  it("warns when no Netlify site is recorded, since previews would reach nobody", async () => {
    const { clientId } = await seedClient();
    existingRepo();

    const body = await (await connect(clientId, { repo: REPOSITORY })).json();

    expect(body.netlifySiteName).toBeNull();
    expect(body.warnings).toEqual([expect.stringContaining("previews")]);
  });

  it("can be repeated: the second call refreshes the connection instead of adding another", async () => {
    const { clientId } = await seedClient();
    existingRepo();

    await connect(clientId, { repo: REPOSITORY });
    const again = await connect(clientId, { repo: REPOSITORY });

    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ alreadyConnected: true });
    expect(await db.select().from(repositoryConnections)).toHaveLength(1);
    const reconnected = await db.select().from(auditLog).where(eq(auditLog.action, "repository.reconnected"));
    expect(reconnected).toHaveLength(1);
  });

  it("answers 404 for a client that does not exist, an id that is not one, and an archived client", async () => {
    existingRepo();
    const missing = "0".repeat(26);
    expect((await connect(missing, { repo: REPOSITORY })).status).toBe(404);

    const malformed = await route.POST(call("x'--", { repo: REPOSITORY }), params("x'--"));
    expect(malformed.status).toBe(404);
    expect((await malformed.json()).error.code).toBe("not_found");

    const { clientId } = await seedClient({ archived: true });
    expect((await connect(clientId, { repo: REPOSITORY })).status).toBe(404);
    expect(await db.select().from(repositoryConnections)).toHaveLength(0);
  });

  it("answers 409 when the client has no site to connect it to, and says what to do", async () => {
    const { clientId } = await seedClient({ siteCount: 0 });
    existingRepo();

    const response = await connect(clientId, { repo: REPOSITORY });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("no_site");
    expect(body.error.message).toContain("Add their site");
    expect(await db.select().from(repositoryConnections)).toHaveLength(0);
  });

  it("answers 409 rather than guess when the client has more than one site", async () => {
    const { clientId, siteRows } = await seedClient({ siteCount: 2 });
    existingRepo();

    const response = await connect(clientId, { repo: REPOSITORY });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("ambiguous_site");
    expect(body.error.details).toEqual(expect.arrayContaining(siteRows.map((site) => site.publicId)));
    expect(await db.select().from(repositoryConnections)).toHaveLength(0);
  });

  it("answers 422 when GitHub cannot see the repository", async () => {
    const { clientId } = await seedClient();

    const response = await connect(clientId, { repo: REPOSITORY });

    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("repo_not_found");
    expect(await db.select().from(repositoryConnections)).toHaveLength(0);
  });

  it("answers 409 for a repository that already belongs to another client's site", async () => {
    const first = await seedClient();
    const second = await seedClient();
    existingRepo();
    expect((await connect(first.clientId, { repo: REPOSITORY })).status).toBe(200);

    const response = await connect(second.clientId, { repo: REPOSITORY });

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("already_connected_elsewhere");
    expect(await db.select().from(repositoryConnections)).toHaveLength(1);
  });

  it("answers 503 when the GitHub App is not configured here", async () => {
    const { clientId } = await seedClient();
    existingRepo();
    const installation = process.env.GITHUB_INSTALLATION_ID;
    delete process.env.GITHUB_INSTALLATION_ID;

    const response = await connect(clientId, { repo: REPOSITORY });
    process.env.GITHUB_INSTALLATION_ID = installation;

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("not_configured");
  });

  it("stops at the hourly quota, counted from the audit log", async () => {
    const { clientId } = await seedClient();
    existingRepo();
    const actorUserId = await ensureOperatorActor(db);
    await db.insert(auditLog).values(
      Array.from({ length: 30 }, () => ({ actorUserId, action: "repository.connected", entityType: "site" })),
    );

    const response = await connect(clientId, { repo: REPOSITORY });

    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe("quota_exceeded");
    expect(await db.select().from(repositoryConnections)).toHaveLength(0);
  });
});
