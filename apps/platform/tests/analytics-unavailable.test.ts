import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db/client";
import { analyticsConnections, sites } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { demoReason, resolveClientAnalytics } from "@/lib/analytics/resolve";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * What the dashboard shows when the analytics provider is not there.
 *
 * The dashboard always renders a chart. When real figures are unavailable it
 * renders invented ones, and the only thing standing between a client and
 * believing invented traffic is their own is `showingDemo` plus the sentence
 * `demoReason` returns. "No data" and "we could not reach the provider" are
 * opposite claims, and a plausible-looking number for either is the worst
 * possible answer.
 *
 * Three ways it can be unavailable, and they must stay distinguishable:
 *
 *   not_configured — the portal has no Umami account at all
 *   not_connected  — the portal has one, this site is not attached to it
 *   error          — the provider is configured, attached, and unreachable
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  acme = await seedTenant(db, "Acme");
});

afterAll(async () => {
  await close();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function addSite(tenant: SeededTenant, name: string) {
  const rows = await db
    .insert(sites)
    .values({
      publicId: newPublicId(),
      organizationId: tenant.organizationId,
      name,
    })
    .returning({ id: sites.id });
  return rows[0]!.id;
}

/** Umami configured at the portal level. Neither value is ever sent to a client. */
function configureUmami() {
  vi.stubEnv("UMAMI_API_BASE_URL", "https://umami.example.test");
  vi.stubEnv("UMAMI_API_KEY", "test-key");
}

function unconfigureUmami() {
  vi.stubEnv("UMAMI_API_BASE_URL", "");
  vi.stubEnv("UMAMI_API_KEY", "");
}

describe("analytics when the provider is unavailable", () => {
  it("says the portal has no analytics account when none is configured", async () => {
    unconfigureUmami();
    await addSite(acme, "Acme Site");

    const resolved = await resolveClientAnalytics(db, acme.ctx, 30);

    expect(resolved.state.kind).toBe("not_configured");
    expect(resolved.showingDemo).toBe(true);
    expect(demoReason(resolved.state)).toMatch(/not connected yet/i);
  });

  it("distinguishes a site that is simply not attached yet", async () => {
    configureUmami();

    const resolved = await resolveClientAnalytics(db, acme.ctx, 30);

    // Configured but unattached is a different sentence, because it is a
    // different thing to do about it.
    expect(resolved.state.kind).toBe("not_connected");
    expect(resolved.showingDemo).toBe(true);
    expect(demoReason(resolved.state)).toMatch(/no analytics attached/i);
  });

  it("still returns a full set of figures, flagged as invented", async () => {
    unconfigureUmami();

    const resolved = await resolveClientAnalytics(db, acme.ctx, 30);

    // The stand-in data exists so the layout is not a hole. The flag is the
    // contract: no caller may render `data` without also honouring this.
    expect(resolved.showingDemo).toBe(true);
    expect(resolved.data).toBeTruthy();
    expect(demoReason(resolved.state)).not.toBeNull();
  });

  it("never claims real figures are unavailable when they are not", async () => {
    // The one state where the figures may be shown as the client's own.
    expect(demoReason({ kind: "ok" } as never)).toBeNull();
  });

  it("blames itself, not the client's traffic, when the provider is unreachable", async () => {
    const reason = demoReason({
      kind: "error",
      message: "503 from upstream",
    } as never);

    expect(reason).toContain("503 from upstream");
    // The wording matters: a client seeing a flat chart with no explanation
    // concludes their traffic collapsed.
    expect(reason).toMatch(/our problem, not a drop in your traffic/i);
  });

  it("resolves a tenant with no site at all rather than throwing", async () => {
    unconfigureUmami();
    const empty = await seedTenant(db, "No Site Co");

    const resolved = await resolveClientAnalytics(db, empty.ctx, 30);

    expect(resolved.site).toBeNull();
    expect(resolved.showingDemo).toBe(true);
    expect(resolved.state.kind).toBe("not_configured");
  });

  it("keeps one tenant's connected site out of another tenant's resolution", async () => {
    configureUmami();
    const globex = await seedTenant(db, "Globex");
    const globexSite = await addSite(globex, "Globex Site");
    await db.insert(analyticsConnections).values({
      siteId: globexSite,
      umamiWebsiteId: "globex-website-id",
      status: "connected",
    });

    // Acme's own site is still unattached, so Acme must resolve to
    // `not_connected` — not to Globex's connected website id.
    const resolved = await resolveClientAnalytics(db, acme.ctx, 30);

    expect(resolved.state.kind).toBe("not_connected");
    expect(resolved.site?.name).toBe("Acme Site");
  });
});
