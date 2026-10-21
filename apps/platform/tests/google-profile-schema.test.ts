import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  googleConnections,
  googleDailyMetrics,
  googleLocations,
  googleProfileChanges,
  googleProfileRequests,
  googleReviews,
  googleSearchKeywords,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * The Google profile tables, against the real migration chain.
 *
 * Shipped ahead of the code that uses them, so what is pinned here is what
 * that code relies on: one live agency connection, one location per client
 * and per Google profile, and the checks that keep a "fewer than 15" search
 * count from being read as a real number.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let globex: SeededTenant;

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
  acme = await seedTenant(db, "Acme Plumbing");
  globex = await seedTenant(db, "Globex Roofing");
});

afterAll(async () => close());

async function connection(email = "agency@example.test") {
  return (
    await db
      .insert(googleConnections)
      .values({
        googleEmail: email,
        googleSubject: `sub-${newPublicId()}`,
        scope: "https://www.googleapis.com/auth/business.manage",
        refreshTokenSealed: "v1.sealed",
      })
      .returning()
  )[0]!;
}

async function location(tenant: SeededTenant, locationName = `locations/${newPublicId()}`) {
  return (
    await db
      .insert(googleLocations)
      .values({
        clientId: tenant.clientId,
        organizationId: tenant.organizationId,
        accountName: "accounts/1",
        locationName,
      })
      .returning()
  )[0]!;
}

describe("google_connections", () => {
  it("allows only one live connection, and any number of revoked ones", async () => {
    const first = await connection();
    await expect(connection("second@example.test")).rejects.toThrow();

    await db
      .update(googleConnections)
      .set({ revokedAt: new Date() })
      .where(sql`${googleConnections.id} = ${first.id}`);
    const second = await connection("second@example.test");
    expect(second.revokedAt).toBeNull();
  });
});

describe("google_locations", () => {
  it("maps a client to one location, and a location to one client", async () => {
    const acmeLocation = await location(acme, "locations/111");

    await expect(location(acme, "locations/222")).rejects.toThrow();
    await expect(location(globex, "locations/111")).rejects.toThrow();

    expect(acmeLocation.syncFailures).toBe(0);
    expect(acmeLocation.snapshot).toBeNull();
  });

  it("refuses a snapshot that is not an object", async () => {
    await expect(
      db.execute(
        sql`insert into google_locations (client_id, organization_id, account_name, location_name, snapshot)
            values (${globex.clientId}, ${globex.organizationId}, 'accounts/1', 'locations/333', '[]'::jsonb)`,
      ),
    ).rejects.toThrow();
  });
});

describe("google_reviews", () => {
  it("keeps one row per Google review and refuses a rating outside 1–5", async () => {
    const [loc] = await db.select().from(googleLocations).where(sql`${googleLocations.clientId} = ${acme.clientId}`);
    const values = {
      locationId: loc!.id,
      organizationId: acme.organizationId,
      googleReviewId: "r-1",
      starRating: 5,
      postedAt: new Date(),
    };
    await db.insert(googleReviews).values(values);
    await expect(db.insert(googleReviews).values(values)).rejects.toThrow();
    await expect(
      db.insert(googleReviews).values({ ...values, googleReviewId: "r-2", starRating: 6 }),
    ).rejects.toThrow();
    await expect(
      db.insert(googleReviews).values({ ...values, googleReviewId: "r-3", draftSource: "robot" }),
    ).rejects.toThrow();
  });
});

describe("google_search_keywords", () => {
  it("holds either a count or a threshold, never both or neither", async () => {
    const [loc] = await db.select().from(googleLocations).where(sql`${googleLocations.clientId} = ${acme.clientId}`);
    const base = { locationId: loc!.id, month: "2026-09-01" };

    await db.insert(googleSearchKeywords).values({ ...base, keyword: "plumber", impressions: 120 });
    await db.insert(googleSearchKeywords).values({ ...base, keyword: "water heater", belowThreshold: 15 });
    await expect(
      db.insert(googleSearchKeywords).values({ ...base, keyword: "both", impressions: 3, belowThreshold: 15 }),
    ).rejects.toThrow();
    await expect(db.insert(googleSearchKeywords).values({ ...base, keyword: "neither" })).rejects.toThrow();
  });
});

describe("google_profile_requests and google_profile_changes", () => {
  it("refuses unknown statuses and kinds", async () => {
    const [loc] = await db.select().from(googleLocations).where(sql`${googleLocations.clientId} = ${acme.clientId}`);
    await expect(
      db.insert(googleProfileRequests).values({
        publicId: newPublicId(),
        organizationId: acme.organizationId,
        clientId: acme.clientId,
        body: "Closed on Thanksgiving",
        status: "maybe",
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(googleProfileChanges).values({
        locationId: loc!.id,
        organizationId: acme.organizationId,
        kind: "logo",
        summary: "x",
        status: "applied",
      }),
    ).rejects.toThrow();
  });

  it("all go with the client", async () => {
    const tenant = await seedTenant(db, "Initech Electric");
    const loc = await location(tenant);
    await db.insert(googleDailyMetrics).values({ locationId: loc.id, date: "2026-10-01", calls: 3 });
    const [ask] = await db
      .insert(googleProfileRequests)
      .values({
        publicId: newPublicId(),
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        body: "New phone number",
      })
      .returning();
    await db.insert(googleProfileChanges).values({
      locationId: loc.id,
      organizationId: tenant.organizationId,
      kind: "hours",
      summary: "Hours updated",
      status: "applied",
      requestId: ask!.id,
    });

    await db.execute(sql`delete from clients where id = ${tenant.clientId}`);

    for (const table of [
      "google_locations",
      "google_daily_metrics",
      "google_profile_requests",
      "google_profile_changes",
    ]) {
      const left = await db.execute(
        sql`select count(*)::int as n from ${sql.identifier(table)} where ${sql.raw(
          table === "google_daily_metrics" ? "location_id" : "organization_id",
        )} = ${table === "google_daily_metrics" ? loc.id : tenant.organizationId}`,
      );
      expect((left.rows[0] as { n: number }).n, table).toBe(0);
    }
  });
});
