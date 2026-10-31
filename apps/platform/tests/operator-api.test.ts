import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  auditLog,
  clients,
  conceptJobs,
  conceptRepositories,
  organizations,
  previewDeployments,
  prospectContacts,
  prospectConversions,
  prospects,
  repositoryConnections,
  siteBriefs,
  sites,
  users,
} from "@/db/schema";
import { sha256Hex } from "@/lib/auth/password";
import { createTestDb } from "./helpers/db";
import type { createGithubFake } from "./helpers/github-fake";

/**
 * The operator API through its route handlers: what it refuses, what it
 * records, and that the two calls do what they say.
 *
 * GitHub, Netlify's site creation and secret sealing are mocked at their
 * boundaries; the database is real, so the audit rows and the system actor
 * are the ones production would write.
 */

const TOKEN = "op_test_8f0c2b9a6d4e1f3a5c7b9d0e2f4a6c8b0d2e4f6a";

let db: Database;
let close: () => Promise<void>;
const github: { fake: ReturnType<typeof createGithubFake> | null } = { fake: null };
const hooks: { createProspect: null | (() => Promise<never>) } = { createProspect: null };

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

vi.mock("@/lib/github/secrets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github/secrets")>()),
  provisionRepoSecrets: async () => ({ written: ["CLAUDE_CODE_OAUTH_TOKEN"], missing: [], failed: [] }),
}));

vi.mock("@/lib/netlify/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/netlify/api")>()),
  isNetlifyConfigured: () => true,
  createSite: async ({ name }: { name: string }) => ({
    id: "nf-new",
    name,
    url: `http://${name}.netlify.app`,
    ssl_url: `https://${name}.netlify.app`,
  }),
}));

vi.mock("@/lib/scheduler/nudge", () => ({ nudgeScheduler: () => undefined }));

vi.mock("@/db/repositories/admin/prospects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/repositories/admin/prospects")>();
  return {
    ...actual,
    createProspect: (...args: Parameters<typeof actual.createProspect>) =>
      hooks.createProspect ? hooks.createProspect() : actual.createProspect(...args),
  };
});

const prospectsRoute = await import("@/app/api/operator/prospects/route");
const convertRoute = await import("@/app/api/operator/prospects/[publicId]/convert/route");
const { ensureOperatorActor, OPERATOR_API_ACTOR_EMAIL } = await import(
  "@/db/repositories/admin/operator-actor"
);
const { authenticate, resolveSession } = await import("@/lib/auth/session");

function call(
  path: string,
  {
    method = "POST",
    body,
    token = TOKEN,
    ip = "203.0.113.5",
    raw,
  }: { method?: string; body?: unknown; token?: string | null; ip?: string; raw?: string } = {},
): Request {
  return new Request(`https://portal.example.test${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "x-forwarded-for": ip,
      "content-type": "application/json",
    },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}

const params = (publicId: string) => ({ params: Promise.resolve({ publicId }) });

async function operatorCalls() {
  return db.select().from(auditLog).where(eq(auditLog.action, "operator_api.call"));
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  process.env.GITHUB_REPO_OWNER = "cjackmort";
  process.env.GITHUB_TEMPLATE_REPO = "client-site-template";
  process.env.GITHUB_INSTALLATION_ID = "123";
});

afterAll(async () => close());

beforeEach(async () => {
  process.env.OPERATOR_API_TOKEN_SHA256 = await sha256Hex(TOKEN);
  github.fake?.reset();
  hooks.createProspect = null;
  for (const table of [
    auditLog,
    prospectConversions,
    previewDeployments,
    conceptRepositories,
    conceptJobs,
    siteBriefs,
    repositoryConnections,
    sites,
    clients,
    prospectContacts,
    prospects,
    users,
    organizations,
  ]) {
    await db.delete(table);
  }
});

describe("refusing a request without the token", () => {
  it("answers 401 and touches nothing when there is no token", async () => {
    const response = await prospectsRoute.POST(call("/api/operator/prospects", { body: { businessName: "X Co" }, token: null }));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9A-Z]{26}$/);
    expect((await response.json()).error.code).toBe("unauthorized");
    // Not even the system user: a refused token never reaches the database.
    expect(await db.select().from(users)).toHaveLength(0);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it("refuses a wrong token", async () => {
    const response = await prospectsRoute.POST(
      call("/api/operator/prospects", { body: { businessName: "X Co" }, token: `${TOKEN}x` }),
    );
    expect(response.status).toBe(401);
  });

  it("refuses every token when the hash is not configured, or is not a SHA-256", async () => {
    delete process.env.OPERATOR_API_TOKEN_SHA256;
    expect((await prospectsRoute.POST(call("/api/operator/prospects", { body: {} }))).status).toBe(401);

    process.env.OPERATOR_API_TOKEN_SHA256 = TOKEN;
    expect((await prospectsRoute.POST(call("/api/operator/prospects", { body: {} }))).status).toBe(401);
  });

  it("slows a flood from one address before looking at the token", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 61; i += 1) {
      const response = await prospectsRoute.POST(call("/api/operator/prospects", { token: "nope", ip: "198.51.100.77" }));
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 60).every((s) => s === 401)).toBe(true);
    expect(statuses[60]).toBe(429);
  });
});

describe("POST /api/operator/prospects", () => {
  it("creates the potential client and its concept, and returns the preview address", async () => {
    const response = await prospectsRoute.POST(
      call("/api/operator/prospects", {
        body: {
          businessName: "Basin View Designs",
          sourceWebsiteUrl: "basinviewdesigns.com",
          contactEmail: "Dana@BasinView.test",
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.prospectId).toMatch(/^[0-9A-Z]{26}$/);
    expect(body.previewUrl).toMatch(/^https:\/\/basin-view-designs-[a-z0-9]+\.netlify\.app$/);
    expect(body.concept).toMatchObject({ status: "built", repository: expect.stringMatching(/^cjackmort\/concept-basin-view-designs-/) });
    // Not allowlisted yet, so the build did not dispatch, and says why.
    expect(body.concept.warning).toContain("not allowlisted");

    const generate = github.fake!.state.calls.find((c) => c.path.endsWith("/generate"));
    expect(generate!.body!.private).toBe(true);

    const [actor] = await db.select().from(users).where(eq(users.email, OPERATOR_API_ACTOR_EMAIL));
    expect(actor).toMatchObject({ role: "admin", status: "disabled", passwordHash: null });

    const [created] = await db.select().from(auditLog).where(eq(auditLog.action, "prospect.created"));
    expect(created!.actorUserId).toBe(actor!.id);

    const [logged] = await operatorCalls();
    expect(logged!.actorUserId).toBe(actor!.id);
    expect(logged!.entityId).toBe(body.prospectId);
    expect(logged!.ipHash).toBe(await sha256Hex("203.0.113.5"));
    expect(logged!.metadata).toMatchObject({
      via: "operator-api",
      call: "prospects.create",
      method: "POST",
      path: "/api/operator/prospects",
      status: 201,
      outcome: "ok",
      requestId: body.requestId,
    });
  });

  it("refuses an unknown field rather than ignoring it", async () => {
    const response = await prospectsRoute.POST(
      call("/api/operator/prospects", { body: { businessName: "Basin View", contactEmial: "a@b.test" } }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_request");
    expect(JSON.stringify(body.error.details)).toContain("contactEmial");
    expect(await db.select().from(prospects)).toHaveLength(0);
    const [logged] = await operatorCalls();
    expect(logged!.metadata).toMatchObject({ status: 400, outcome: "invalid_request" });
  });

  it("refuses a body that is not JSON, and one that is too large", async () => {
    expect((await prospectsRoute.POST(call("/api/operator/prospects", { raw: "{nope" }))).status).toBe(400);
    const huge = await prospectsRoute.POST(
      call("/api/operator/prospects", { body: { businessName: "Big", notes: "x".repeat(40_000) } }),
    );
    expect(huge.status).toBe(413);
  });

  it("refuses a second potential client with the same name unless told to", async () => {
    const first = await (await prospectsRoute.POST(
      call("/api/operator/prospects", { body: { businessName: "Basin View", buildConcept: false } }),
    )).json();

    const again = await prospectsRoute.POST(
      call("/api/operator/prospects", { body: { businessName: "basin view", buildConcept: false } }),
    );
    const body = await again.json();
    expect(again.status).toBe(409);
    expect(body.error).toMatchObject({ code: "duplicate_prospect", details: { prospectId: first.prospectId } });

    const allowed = await prospectsRoute.POST(
      call("/api/operator/prospects", { body: { businessName: "basin view", buildConcept: false, allowDuplicate: true } }),
    );
    expect(allowed.status).toBe(201);
  });

  it("stops at the hourly quota, counted from the audit log", async () => {
    const actorUserId = await ensureOperatorActor(db);
    await db.insert(auditLog).values(
      Array.from({ length: 10 }, () => ({
        actorUserId,
        action: "prospect.created",
        entityType: "prospect",
      })),
    );

    const response = await prospectsRoute.POST(call("/api/operator/prospects", { body: { businessName: "One More" } }));
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe("quota_exceeded");
  });

  it("answers an unexpected failure with the request id and nothing else", async () => {
    hooks.createProspect = async () => {
      throw new Error("connection string postgres://secret@internal-host");
    };

    const response = await prospectsRoute.POST(call("/api/operator/prospects", { body: { businessName: "Boom Co" } }));
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("secret");
    expect(text).not.toContain("internal-host");
    expect(JSON.parse(text)).toMatchObject({ error: { code: "internal" }, requestId: expect.any(String) });
    const [logged] = await operatorCalls();
    expect(logged!.metadata).toMatchObject({ status: 500, outcome: "internal" });
  });
});

describe("the system actor", () => {
  it("cannot sign in or hold a session", async () => {
    const actorUserId = await ensureOperatorActor(db);

    expect((await authenticate(db, OPERATOR_API_ACTOR_EMAIL, "anything at all")).ok).toBe(false);
    expect(await resolveSession(db, { userId: actorUserId, sessionEpoch: 0 })).toBeNull();
  });

  it("is refused as an identity if anyone ever activates it", async () => {
    const actorUserId = await ensureOperatorActor(db);
    await db.update(users).set({ status: "active" }).where(eq(users.id, actorUserId));

    const response = await prospectsRoute.POST(call("/api/operator/prospects", { body: { businessName: "X Co" } }));
    expect(response.status).toBe(503);
    expect(await db.select().from(prospects)).toHaveLength(0);
  });
});

describe("/api/operator/prospects/:id/convert", () => {
  async function prospectWithoutConcept(): Promise<string> {
    const response = await prospectsRoute.POST(
      call("/api/operator/prospects", {
        body: { businessName: "Hair by Graci", contactEmail: "graci@example.test", buildConcept: false },
      }),
    );
    return (await response.json()).prospectId;
  }

  it("reports not_started, then the conversion it ran", async () => {
    const id = await prospectWithoutConcept();

    const before = await convertRoute.GET(call(`/api/operator/prospects/${id}/convert`, { method: "GET" }), params(id));
    expect(await before.json()).toMatchObject({ state: "not_started", report: null });

    const converted = await convertRoute.POST(call(`/api/operator/prospects/${id}/convert`), params(id));
    const report = await converted.json();
    expect(converted.status).toBe(200);
    expect(report.via).toBe("operator-api");
    expect(report.steps.find((s: { id: string }) => s.id === "client").status).toBe("ok");
    expect(report.steps.find((s: { id: string }) => s.id === "client_invite").status).toBe("skipped");
    expect(JSON.stringify(report).toLowerCase()).not.toContain("password\":");

    const [conversion] = await db.select().from(prospectConversions);
    const [actor] = await db.select().from(users).where(eq(users.email, OPERATOR_API_ACTOR_EMAIL));
    expect(conversion!.convertedBy).toBe(actor!.id);

    const after = await convertRoute.GET(call(`/api/operator/prospects/${id}/convert`, { method: "GET" }), params(id));
    expect(await after.json()).toMatchObject({ state: "finished", report: { clientId: report.clientId } });

    const calls = (await operatorCalls()).map((row) => (row.metadata as { call: string }).call);
    expect(calls).toEqual(
      expect.arrayContaining(["prospects.create", "prospects.convert.report", "prospects.convert"]),
    );
  });

  it("answers 409 while a conversion is running", async () => {
    const id = await prospectWithoutConcept();
    await db.insert(auditLog).values({ action: "prospect.conversion_started", entityType: "prospect", entityId: id });

    const response = await convertRoute.POST(call(`/api/operator/prospects/${id}/convert`), params(id));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("conversion_in_progress");
  });

  it("refuses an unknown step to re-run", async () => {
    const id = await prospectWithoutConcept();
    const response = await convertRoute.POST(
      call(`/api/operator/prospects/${id}/convert`, { body: { rerun: ["everything"] } }),
      params(id),
    );
    expect(response.status).toBe(400);
  });

  it("answers 404 for a prospect that does not exist and for an id that is not one", async () => {
    const missing = "0".repeat(26);
    const absent = await convertRoute.GET(call(`/api/operator/prospects/${missing}/convert`, { method: "GET" }), params(missing));
    expect(absent.status).toBe(404);

    const malformed = await convertRoute.POST(call("/api/operator/prospects/x'--/convert"), params("x'--"));
    expect(malformed.status).toBe(404);
    expect((await malformed.json()).error.code).toBe("not_found");
  });
});
