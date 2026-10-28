import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { connectedAccounts, searchSnapshots, sites } from "@/db/schema";
import { completeConnect } from "@/db/repositories/client/connections";
import {
  getSearchView,
  takeOwnSearchSnapshot,
  takeSearchSnapshot,
  type SnapshotFetcher,
} from "@/db/repositories/client/search-snapshots";
import { runScheduledSearchSnapshots } from "@/db/repositories/admin/search-snapshots";
import { AuthorizationError, tenantContextFrom } from "@/db/repositories/context";
import type { SearchSnapshot } from "@/lib/connections/providers/google";
import { ProviderError } from "@/lib/connections/types";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * Search snapshots.
 *
 * What would go wrong quietly: a failed fetch shown as a month with no
 * searches; a snapshot taken twice a day for the same site; a good morning
 * snapshot overwritten by an afternoon failure; one client's queries on
 * another's page; and a lapsed Google grant retried every tick for ever.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let globex: SeededTenant;

const NOW = new Date("2026-10-27T12:00:00Z");
const LATER_TODAY = new Date("2026-10-27T20:00:00Z");
const TOMORROW = new Date("2026-10-28T12:00:00Z");

// The sealing key tests use. 32 zero bytes is a valid key, not a secret.
process.env.CONNECTION_TOKEN_KEY = Buffer.alloc(32).toString("base64");
const ENV = {
  GOOGLE_CLIENT_ID: "id",
  GOOGLE_CLIENT_SECRET: "secret",
  AUTH_URL: "https://portal.example.test",
  CONNECTION_TOKEN_KEY: process.env.CONNECTION_TOKEN_KEY,
};

const SNAPSHOT: SearchSnapshot = {
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
  pages: [],
  daily: [{ date: "2026-10-01", clicks: 4, impressions: 150, position: 8 }],
};

const succeeds: SnapshotFetcher = async () => ({ snapshot: SNAPSHOT, update: { accessToken: "renewed" } });
const unavailable: SnapshotFetcher = async () => {
  throw new ProviderError("unavailable", "Google 503: try later");
};
const lapsed: SnapshotFetcher = async () => {
  throw new ProviderError("auth", "Google 401: invalid_grant");
};

async function connectGoogle(tenant: SeededTenant) {
  await completeConnect(
    db,
    tenant.ctx,
    "google",
    {
      externalId: `sub-${tenant.organizationId}`,
      displayName: "owner@example.test",
      scope: "openid email https://www.googleapis.com/auth/webmasters.readonly",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: new Date("2026-10-27T13:00:00Z"),
    },
    NOW,
  );
}

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
  acme = await seedTenant(db, "Acme Plumbing");
  globex = await seedTenant(db, "Globex Roofing");
  for (const [tenant, domain] of [
    [acme, "www.acmeplumbing.example"],
    [globex, "globexroofing.example"],
  ] as const) {
    await db.insert(sites).values({
      publicId: newPublicId(),
      organizationId: tenant.organizationId,
      name: tenant === acme ? "Acme" : "Globex",
      primaryDomain: domain,
    });
  }
});

afterAll(async () => close());

afterEach(async () => {
  await db.delete(searchSnapshots);
  await db.delete(connectedAccounts);
});

describe("taking a snapshot", () => {
  it("keeps the day's figures, the property it matched, and the renewed token", async () => {
    await connectGoogle(acme);

    const run = await takeSearchSnapshot(db, acme.organizationId, { now: NOW, fetchSnapshot: succeeds, env: ENV });

    expect(run.ok).toBe(true);
    const [row] = await db.select().from(searchSnapshots);
    expect(row).toMatchObject({ takenOn: "2026-10-27", property: "sc-domain:acmeplumbing.example", error: null });
    expect(row!.data).toEqual(SNAPSHOT);
    expect(row!.fetchedAt).toEqual(NOW);
    const [account] = await db.select({ sealed: connectedAccounts.accessTokenSealed }).from(connectedAccounts);
    expect(account!.sealed).not.toContain("renewed");
    expect(account!.sealed?.startsWith("v1.")).toBe(true);
  });

  it("says plainly, and records, when Google could not be read — never a quiet month", async () => {
    await connectGoogle(acme);

    const run = await takeSearchSnapshot(db, acme.organizationId, { now: NOW, fetchSnapshot: unavailable, env: ENV });

    expect(run).toMatchObject({ ok: false, reason: "failed" });
    const [row] = await db.select().from(searchSnapshots);
    expect(row).toMatchObject({ takenOn: "2026-10-27", data: null, error: "Google 503: try later", fetchedAt: null });

    const view = await getSearchView(db, acme.ctx, { now: NOW });
    expect(view).toMatchObject({ state: "failed", error: "Google 503: try later" });
  });

  it("does not let an afternoon failure erase the morning's good snapshot", async () => {
    await connectGoogle(acme);
    await takeSearchSnapshot(db, acme.organizationId, { now: NOW, fetchSnapshot: succeeds, env: ENV });

    await takeSearchSnapshot(db, acme.organizationId, { now: LATER_TODAY, fetchSnapshot: unavailable, env: ENV });

    const rows = await db.select().from(searchSnapshots);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toEqual(SNAPSHOT);
    expect(rows[0]!.error).toBeNull();
    expect(rows[0]!.attemptedAt).toEqual(LATER_TODAY);
  });

  it("replaces a failed day with the figures once a retry succeeds", async () => {
    await connectGoogle(acme);
    await takeSearchSnapshot(db, acme.organizationId, { now: NOW, fetchSnapshot: unavailable, env: ENV });

    await takeSearchSnapshot(db, acme.organizationId, { now: LATER_TODAY, fetchSnapshot: succeeds, env: ENV });

    const rows = await db.select().from(searchSnapshots);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ error: null, fetchedAt: LATER_TODAY });
  });

  it("marks a lapsed grant for reconnection instead of retrying it", async () => {
    await connectGoogle(acme);

    const run = await takeSearchSnapshot(db, acme.organizationId, { now: NOW, fetchSnapshot: lapsed, env: ENV });

    expect(run).toMatchObject({ ok: false, reason: "needs_reconnect" });
    const [account] = await db.select({ status: connectedAccounts.status }).from(connectedAccounts);
    expect(account!.status).toBe("needs_reconnect");
    expect(await getSearchView(db, acme.ctx, { now: NOW })).toMatchObject({ state: "needs_reconnect" });
    // The next run does not touch Google.
    let called = 0;
    const counting: SnapshotFetcher = async () => {
      called += 1;
      return { snapshot: SNAPSHOT };
    };
    await takeSearchSnapshot(db, acme.organizationId, { now: LATER_TODAY, fetchSnapshot: counting, env: ENV });
    expect(called).toBe(0);
  });

  it("records that the server is not set up rather than failing silently", async () => {
    await connectGoogle(acme);

    const run = await takeSearchSnapshot(db, acme.organizationId, { now: NOW, fetchSnapshot: succeeds, env: {} });

    expect(run).toMatchObject({ ok: false, reason: "not_configured" });
    const [row] = await db.select({ error: searchSnapshots.error }).from(searchSnapshots);
    expect(row!.error).toContain("GOOGLE_CLIENT_SECRET");
  });

  it("refuses the client's own button while an operator is viewing as them", async () => {
    const viewing = tenantContextFrom(
      { userId: acme.userId, organizationId: acme.organizationId, role: "client", status: "active", sessionEpoch: 0 },
      acme.organizationId,
      { impersonating: true },
    );
    await expect(takeOwnSearchSnapshot(db, viewing, { now: NOW, fetchSnapshot: succeeds, env: ENV })).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});

describe("the view", () => {
  it("asks to connect Google first when nothing is connected", async () => {
    expect(await getSearchView(db, acme.ctx, { now: NOW })).toEqual({ state: "not_connected" });
  });

  it("is pending while connected and not yet fetched", async () => {
    await connectGoogle(acme);
    expect(await getSearchView(db, acme.ctx, { now: NOW })).toMatchObject({ state: "pending", connectedAs: "owner@example.test" });
  });

  it("shows the latest figures with the trend of earlier days, and flags a newer failure", async () => {
    await connectGoogle(acme);
    const earlier: SnapshotFetcher = async () => ({
      snapshot: { ...SNAPSHOT, totals: { ...SNAPSHOT.totals, impressions: 3000 } },
    });
    await takeSearchSnapshot(db, acme.organizationId, { now: new Date("2026-10-26T12:00:00Z"), fetchSnapshot: earlier, env: ENV });
    await takeSearchSnapshot(db, acme.organizationId, { now: NOW, fetchSnapshot: succeeds, env: ENV });
    await takeSearchSnapshot(db, acme.organizationId, { now: TOMORROW, fetchSnapshot: unavailable, env: ENV });

    const view = await getSearchView(db, acme.ctx, { now: TOMORROW });

    expect(view.state).toBe("ready");
    if (view.state !== "ready") return;
    expect(view.snapshot.totals.impressions).toBe(4000);
    expect(view.fetchedAt).toEqual(NOW);
    expect(view.trend.map((t) => [t.takenOn, t.impressions])).toEqual([
      ["2026-10-26", 3000],
      ["2026-10-27", 4000],
    ]);
    expect(view.staleError).toMatchObject({ error: "Google 503: try later", attemptedAt: TOMORROW });
  });

  it("never shows one client's searches to another", async () => {
    await connectGoogle(acme);
    await takeSearchSnapshot(db, acme.organizationId, { now: NOW, fetchSnapshot: succeeds, env: ENV });

    expect(await getSearchView(db, globex.ctx, { now: NOW })).toEqual({ state: "not_connected" });
  });
});

describe("the scheduled job", () => {
  it("takes one snapshot a day per connected client, and leaves the rest alone", async () => {
    await connectGoogle(acme);
    await connectGoogle(globex);
    process.env.GOOGLE_CLIENT_ID = ENV.GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_SECRET = ENV.GOOGLE_CLIENT_SECRET;
    process.env.AUTH_URL = ENV.AUTH_URL;
    try {
      const first = await runScheduledSearchSnapshots(db, { now: NOW, fetchSnapshot: succeeds });
      expect(first).toEqual({ taken: 2, failed: 0, skipped: 0 });

      const again = await runScheduledSearchSnapshots(db, { now: LATER_TODAY, fetchSnapshot: succeeds });
      expect(again).toEqual({ taken: 0, failed: 0, skipped: 0 });
      expect(await db.select().from(searchSnapshots)).toHaveLength(2);

      const tomorrow = await runScheduledSearchSnapshots(db, { now: TOMORROW, fetchSnapshot: succeeds });
      expect(tomorrow.taken).toBe(2);
    } finally {
      delete process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_SECRET;
      delete process.env.AUTH_URL;
    }
  });

  it("retries a failed day after six hours, not every tick", async () => {
    await connectGoogle(acme);
    process.env.GOOGLE_CLIENT_ID = ENV.GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_SECRET = ENV.GOOGLE_CLIENT_SECRET;
    process.env.AUTH_URL = ENV.AUTH_URL;
    try {
      expect(await runScheduledSearchSnapshots(db, { now: NOW, fetchSnapshot: unavailable })).toMatchObject({ failed: 1 });

      const soon = new Date(NOW.getTime() + 60 * 60 * 1000);
      expect(await runScheduledSearchSnapshots(db, { now: soon, fetchSnapshot: succeeds })).toEqual({ taken: 0, failed: 0, skipped: 0 });

      expect(await runScheduledSearchSnapshots(db, { now: LATER_TODAY, fetchSnapshot: succeeds })).toMatchObject({ taken: 1 });
      const [row] = await db.select({ error: searchSnapshots.error }).from(searchSnapshots).where(eq(searchSnapshots.organizationId, acme.organizationId));
      expect(row!.error).toBeNull();
    } finally {
      delete process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_SECRET;
      delete process.env.AUTH_URL;
    }
  });
});
