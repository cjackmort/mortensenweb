import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, connectedAccounts, sites } from "@/db/schema";
import {
  completeConnect,
  disconnect,
  listConnectedAccounts,
  runAudit,
} from "@/db/repositories/client/connections";
import { runScheduledConnectionAudits } from "@/db/repositories/admin/connection-audits";
import { AuthorizationError, tenantContextFrom } from "@/db/repositories/context";
import type { OAuthAdapter } from "@/lib/connections";
import { findingsNote } from "@/lib/connections/report";
import { auditInstagram, type InstagramSnapshot } from "@/lib/connections/providers/instagram";
import { auditSearch, matchProperty, type SearchSnapshot } from "@/lib/connections/providers/google";
import { auditStripe, type StripeSnapshot } from "@/lib/connections/providers/stripe";
import { AUDIT_VERSION, ProviderError, type AuditOutcome } from "@/lib/connections/types";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * Connected accounts.
 *
 * What would go wrong quietly: a token written in the clear; one client's
 * Stripe findings in another's report; a lapsed grant retried for ever
 * instead of asking to reconnect; and a disconnect that left the token
 * usable. The audits themselves are pure, so their rules are pinned on
 * fixtures without any provider.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let globex: SeededTenant;

const NOW = new Date("2026-10-27T12:00:00Z");
const WINDOW = { now: NOW, startAt: new Date("2026-09-27T12:00:00Z"), endAt: NOW };

// The sealing key tests use. 32 zero bytes is a valid key, not a secret.
process.env.CONNECTION_TOKEN_KEY = Buffer.alloc(32).toString("base64");

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
  acme = await seedTenant(db, "Acme Plumbing");
  globex = await seedTenant(db, "Globex Roofing");
  await db.insert(sites).values({
    publicId: newPublicId(),
    organizationId: acme.organizationId,
    name: "Acme",
    primaryDomain: "www.acmeplumbing.example",
  });
});

afterAll(async () => close());

afterEach(async () => {
  await db.delete(connectedAccounts);
});

function fakeAdapter(overrides: Partial<OAuthAdapter> = {}): OAuthAdapter {
  const outcome: AuditOutcome = {
    audit: {
      version: AUDIT_VERSION,
      at: NOW.toISOString(),
      startAt: WINDOW.startAt.toISOString(),
      endAt: NOW.toISOString(),
      headline: "3 posts in 30 days, 240 followers",
      rows: [{ label: "Followers", value: "240" }],
      findings: [{ severity: "improve", title: "3 posts in the last 30 days", detail: "Aim for four." }],
      snapshot: {},
    },
    tokens: { accessToken: "renewed-token", expiresAt: new Date("2026-12-20T00:00:00Z") },
  };
  return {
    key: "instagram",
    connectWith: "oauth",
    name: "Instagram",
    what: "",
    looksAt: [],
    never: "",
    configured: () => ({ ok: true }),
    begin: async () => ({ url: "https://example.test/auth", codeVerifier: "" }),
    complete: async () => ({
      externalId: "ig-1",
      displayName: "@acme",
      scope: "basic",
      accessToken: "long-lived",
      refreshToken: null,
      expiresAt: new Date("2026-12-01T00:00:00Z"),
    }),
    audit: async () => outcome,
    revoke: async () => {},
    ...overrides,
  };
}

describe("connecting", () => {
  it("seals the tokens, keeps one live row per provider, and lists it for the client only", async () => {
    await completeConnect(db, acme.ctx, "instagram", await fakeAdapter().complete({ code: "c", codeVerifier: "" }), NOW);
    const [row] = await db.select().from(connectedAccounts);
    expect(row!.accessTokenSealed).not.toContain("long-lived");
    expect(row!.accessTokenSealed?.startsWith("v1.")).toBe(true);
    expect(row!.refreshTokenSealed).toBeNull();

    // Connecting again replaces: the first row becomes history.
    await completeConnect(db, acme.ctx, "instagram", await fakeAdapter().complete({ code: "c", codeVerifier: "" }), NOW);
    const rows = await db.select({ status: connectedAccounts.status }).from(connectedAccounts);
    expect(rows.map((r) => r.status).sort()).toEqual(["connected", "revoked"]);

    expect((await listConnectedAccounts(db, acme.ctx)).map((a) => a.provider)).toEqual(["instagram"]);
    expect(await listConnectedAccounts(db, globex.ctx)).toEqual([]);
  });

  it("refuses while an operator is viewing as the client", async () => {
    const viewing = tenantContextFrom(
      { userId: acme.userId, organizationId: acme.organizationId, role: "client", status: "active", sessionEpoch: 0 },
      acme.organizationId,
      { impersonating: true },
    );
    await expect(
      completeConnect(db, viewing, "stripe", { externalId: "acct_1", displayName: null, scope: "", accessToken: null, refreshToken: null, expiresAt: null }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("auditing", () => {
  it("stores the audit, keeps renewed tokens sealed, and hands the site host to the provider", async () => {
    let seenHost: string | null | undefined;
    const adapter = fakeAdapter({
      audit: async (tokens, context) => {
        seenHost = context.siteHost;
        expect(tokens.accessToken).toBe("long-lived");
        return fakeAdapter().audit(tokens, context);
      },
    });
    await completeConnect(db, acme.ctx, "instagram", await adapter.complete({ code: "c", codeVerifier: "" }), NOW);

    const run = await runAudit(db, acme.organizationId, "instagram", { adapter, now: NOW });
    expect(run.ok).toBe(true);
    expect(seenHost).toBe("acmeplumbing.example");

    const [account] = await listConnectedAccounts(db, acme.ctx);
    expect(account!.lastAudit?.headline).toBe("3 posts in 30 days, 240 followers");
    expect(account!.lastAuditAt).toEqual(NOW);

    const [row] = await db.select().from(connectedAccounts).where(eq(connectedAccounts.status, "connected"));
    expect(row!.accessTokenSealed).not.toContain("renewed-token");
    expect(row!.tokenExpiresAt).toEqual(new Date("2026-12-20T00:00:00Z"));
  });

  it("marks a lapsed grant as needing reconnecting, and a passing outage as an error only", async () => {
    const lapsed = fakeAdapter({
      audit: async () => {
        throw new ProviderError("auth", "token expired");
      },
    });
    await completeConnect(db, acme.ctx, "instagram", await lapsed.complete({ code: "c", codeVerifier: "" }), NOW);
    const first = await runAudit(db, acme.organizationId, "instagram", { adapter: lapsed, now: NOW });
    expect(first).toMatchObject({ ok: false, reason: "needs_reconnect" });
    expect((await listConnectedAccounts(db, acme.ctx))[0]!.status).toBe("needs_reconnect");

    await db.delete(connectedAccounts);
    const flaky = fakeAdapter({
      audit: async () => {
        throw new ProviderError("unavailable", "503");
      },
    });
    await completeConnect(db, acme.ctx, "instagram", await flaky.complete({ code: "c", codeVerifier: "" }), NOW);
    const second = await runAudit(db, acme.organizationId, "instagram", { adapter: flaky, now: NOW });
    expect(second).toMatchObject({ ok: false, reason: "unavailable" });
    const [account] = await listConnectedAccounts(db, acme.ctx);
    expect(account!.status).toBe("connected");
    expect(account!.lastError).toBe("503");
  });

  it("the scheduled run looks only at accounts not looked at in a day", async () => {
    const adapter = fakeAdapter();
    await completeConnect(db, acme.ctx, "instagram", await adapter.complete({ code: "c", codeVerifier: "" }), NOW);
    // The real adapter would call Instagram; the row is marked fresh so it is skipped.
    await db.update(connectedAccounts).set({ lastAuditAt: NOW });
    expect(await runScheduledConnectionAudits(db, { now: NOW })).toEqual({ audited: 0, failed: 0, skipped: 0 });
  });
});

describe("disconnecting", () => {
  it("tells the provider, clears the tokens, and keeps the row as history", async () => {
    let revoked = false;
    const adapter = fakeAdapter({
      revoke: async (tokens) => {
        revoked = tokens.accessToken === "long-lived";
      },
    });
    await completeConnect(db, acme.ctx, "instagram", await adapter.complete({ code: "c", codeVerifier: "" }), NOW);
    expect(await disconnect(db, acme.ctx, "instagram", { adapter }, NOW)).toBe(true);
    expect(revoked).toBe(true);

    const [row] = await db.select().from(connectedAccounts);
    expect(row!.status).toBe("revoked");
    expect(row!.accessTokenSealed).toBeNull();
    expect(await listConnectedAccounts(db, acme.ctx)).toEqual([]);
    expect(await disconnect(db, acme.ctx, "instagram", { adapter }, NOW)).toBe(false);

    const actions = (await db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.organizationId, acme.organizationId))).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["connection.connected", "connection.disconnected"]));
  });
});

describe("the Stripe audit", () => {
  const healthy: StripeSnapshot = {
    accountId: "acct_1",
    currency: "usd",
    chargesEnabled: true,
    payoutsEnabled: true,
    requirementsDue: [],
    statementDescriptor: "ACME PLUMBING",
    businessUrl: "https://www.acmeplumbing.example",
    supportEmail: "help@acmeplumbing.example",
    supportPhone: null,
    charges: { count: 12, grossCents: 480000 },
    refunds: { count: 0, cents: 0 },
    disputes: { count: 0, cents: 0 },
    attempts: { succeeded: 12, failed: 1 },
  };
  const ctx = { ...WINDOW, siteHost: "acmeplumbing.example" };

  it("calls a clean month healthy", () => {
    const audit = auditStripe(healthy, ctx);
    expect(audit.headline).toBe("$4,800.00 taken in 12 payments");
    expect(audit.findings.map((f) => f.severity)).toEqual(["good"]);
  });

  it("puts what Stripe is waiting on, disputes and refunds first", () => {
    const audit = auditStripe(
      {
        ...healthy,
        payoutsEnabled: false,
        requirementsDue: ["individual.id_number"],
        disputes: { count: 1, cents: 20000 },
        refunds: { count: 3, cents: 60000 },
        attempts: { succeeded: 10, failed: 4 },
        statementDescriptor: null,
        businessUrl: "https://old-site.example",
        supportEmail: null,
      },
      ctx,
    );
    expect(audit.findings.map((f) => f.title)).toEqual([
      "Stripe is waiting on information from you",
      "Payouts are switched off",
      "1 dispute this month",
      "13% of takings were refunded",
      "29% of payment attempts failed",
      "No statement descriptor",
      "Stripe's website is not your current site",
      "No support contact on receipts",
    ]);
    expect(audit.findings.every((f) => f.severity !== "good")).toBe(true);
  });

  it("says when nothing was paid, differently for an account that cannot take payment", () => {
    const quiet = auditStripe({ ...healthy, charges: { count: 0, grossCents: 0 }, attempts: { succeeded: 0, failed: 0 } }, ctx);
    expect(quiet.findings[0]!.title).toBe("Nothing was paid through Stripe in the last 30 days");
    expect(quiet.findings[0]!.detail).toContain("payment links");
    const unfinished = auditStripe(
      { ...healthy, charges: { count: 0, grossCents: 0 }, attempts: { succeeded: 0, failed: 0 }, chargesEnabled: false },
      ctx,
    );
    expect(unfinished.findings[0]!.detail).toContain("Finish Stripe's setup");
  });
});

describe("the Instagram audit", () => {
  const post = (daysAgo: number, extra: Partial<InstagramSnapshot["posts"][number]> = {}) => ({
    id: `p${daysAgo}`,
    timestamp: new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    mediaType: "IMAGE",
    likes: 30,
    comments: 2,
    ...extra,
  });
  const base: InstagramSnapshot = {
    username: "acme",
    name: "Acme Plumbing",
    biography: "Plumbers in Provo",
    website: "https://acmeplumbing.example/",
    followers: 500,
    mediaCount: 40,
    posts: [post(2, { mediaType: "VIDEO" }), post(9), post(16), post(23), post(40)],
  };
  const ctx = { ...WINDOW, siteHost: "acmeplumbing.example" };

  it("calls weekly posting steady and counts only the window", () => {
    const audit = auditInstagram(base, ctx);
    expect(audit.headline).toBe("4 posts in 30 days, 500 followers");
    expect(audit.findings.map((f) => f.title)).toEqual(["Posting steadily — 4 in the last 30 days"]);
  });

  it("flags a gone-quiet account, a missing bio link, and no video", () => {
    const audit = auditInstagram(
      { ...base, website: null, biography: null, posts: [post(45), post(60), post(70)] },
      ctx,
    );
    expect(audit.findings.map((f) => `${f.severity}:${f.title}`)).toEqual([
      "fix:Last post was 45 days ago",
      "fix:No website link in the bio",
      "improve:The bio is empty",
      "improve:No video in recent posts",
    ]);
  });

  it("notices a bio link that goes somewhere else, and few responses", () => {
    const audit = auditInstagram(
      { ...base, website: "https://linktr.ee/acme", posts: base.posts.map((p) => ({ ...p, likes: 1, comments: 0 })) },
      ctx,
    );
    expect(audit.findings.map((f) => f.title)).toContain("The bio link is not your site");
    expect(audit.findings.map((f) => f.title)).toContain("Few responses — 0.2% of followers react to a post");
  });
});

describe("the Search Console audit", () => {
  const base: SearchSnapshot = {
    property: "sc-domain:acmeplumbing.example",
    properties: ["sc-domain:acmeplumbing.example"],
    startDate: "2026-09-28",
    endDate: "2026-10-25",
    totals: { clicks: 120, impressions: 4000, ctr: 0.03, position: 8.2 },
    previous: { clicks: 100, impressions: 3500 },
    queries: [
      { key: "plumber provo", clicks: 40, impressions: 900, ctr: 0.044, position: 3.1 },
      { key: "water heater repair provo", clicks: 6, impressions: 300, ctr: 0.02, position: 7.4 },
    ],
    pages: [{ key: "https://acmeplumbing.example/services", clicks: 2, impressions: 400, ctr: 0.005, position: 9 }],
    daily: [],
  };
  const ctx = { ...WINDOW, siteHost: "acmeplumbing.example" };

  it("matches a domain property first, then a URL property, by host", () => {
    expect(matchProperty(["https://acmeplumbing.example/", "sc-domain:acmeplumbing.example"], "www.acmeplumbing.example")).toBe(
      "sc-domain:acmeplumbing.example",
    );
    expect(matchProperty(["https://www.acmeplumbing.example/"], "acmeplumbing.example")).toBe("https://www.acmeplumbing.example/");
    expect(matchProperty(["https://other.example/"], "acmeplumbing.example")).toBeNull();
  });

  it("points at the near-page-one query and the seen-but-unclicked page, and notices growth", () => {
    const audit = auditSearch(base, ctx);
    expect(audit.headline).toBe("120 clicks from Google, shown 4000 times");
    expect(audit.findings.map((f) => f.title)).toEqual([
      "Close to the top of Google for “water heater repair provo”",
      "Pages that are seen but not clicked",
      "Clicks from Google up 20%",
    ]);
    expect(audit.findings[1]!.detail).toContain("/services (400 shown, 0.5% clicked)");
  });

  it("says plainly when the site is not among the account's properties", () => {
    const audit = auditSearch({ ...base, property: null, properties: ["https://other.example/"], queries: [], pages: [] }, ctx);
    expect(audit.headline).toBe("Site not found in Search Console");
    expect(audit.findings[0]).toMatchObject({ severity: "fix", title: "acmeplumbing.example is not in this Google account's Search Console" });
    expect(audit.rows).toEqual([]);
  });
});

describe("the report note", () => {
  it("leads with what to fix, then what to improve, and says where the detail is", () => {
    expect(
      findingsNote([
        { severity: "improve", title: "No video in recent posts", detail: "" },
        { severity: "fix", title: "No website link in the bio", detail: "" },
        { severity: "good", title: "Posting steadily", detail: "" },
      ]),
    ).toBe("To fix: No website link in the bio. To improve: No video in recent posts. The details are under Connections in your portal.");
    expect(findingsNote([{ severity: "good", title: "Payments look healthy", detail: "" }])).toBe(
      "Payments look healthy. The details are under Connections in your portal.",
    );
    expect(findingsNote([])).toBeNull();
  });
});
