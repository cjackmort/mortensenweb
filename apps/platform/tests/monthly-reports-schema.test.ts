import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { monthlyReportPreferences, monthlyReports, organizations } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * The monthly report tables, against the real migration chain.
 *
 * Shipped ahead of the code that uses it, so what is pinned is the shape that
 * code relies on: one report per organization and month — the property that
 * keeps two overlapping scheduler runs from emailing a client twice — and a
 * period that is always `YYYY-MM`, because it is also a URL segment.
 */

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
});

afterAll(async () => close());

async function org() {
  return (
    await db
      .insert(organizations)
      .values({
        publicId: newPublicId(),
        name: "Acme",
        slug: `acme-${newPublicId().slice(0, 6).toLowerCase()}`,
        kind: "client",
      })
      .returning()
  )[0]!;
}

describe("monthly_reports", () => {
  it("holds one report per organization and month", async () => {
    const { id } = await org();
    await db.insert(monthlyReports).values({ organizationId: id, period: "2026-09", data: { version: 1 } });

    await expect(
      db.insert(monthlyReports).values({ organizationId: id, period: "2026-09", data: { version: 1 } }),
    ).rejects.toThrow();

    // A different month is a different report.
    await db.insert(monthlyReports).values({ organizationId: id, period: "2026-10", data: { version: 1 } });
  });

  it("refuses a period that is not YYYY-MM", async () => {
    const { id } = await org();
    for (const period of ["2026-13", "2026-9", "26-09", "2026-09-01", "../x"]) {
      await expect(
        db.insert(monthlyReports).values({ organizationId: id, period, data: { version: 1 } }),
      ).rejects.toThrow();
    }
  });

  it("refuses data that is not an object", async () => {
    const { id } = await org();
    await expect(
      db.execute(
        sql`insert into monthly_reports (organization_id, period, data) values (${id}, '2026-08', '[]'::jsonb)`,
      ),
    ).rejects.toThrow();
  });

  it("refuses an email status it does not know", async () => {
    const { id } = await org();
    await expect(
      db.insert(monthlyReports).values({
        organizationId: id,
        period: "2026-07",
        data: { version: 1 },
        emailStatus: "delivered",
      }),
    ).rejects.toThrow();
  });

  it("goes when the organization does", async () => {
    const { id } = await org();
    await db.insert(monthlyReports).values({ organizationId: id, period: "2026-09", data: { version: 1 } });
    await db.insert(monthlyReportPreferences).values({ organizationId: id, emailsOffAt: new Date() });
    await db.execute(sql`delete from organizations where id = ${id}`);

    const reports = await db.execute(
      sql`select count(*)::int as n from monthly_reports where organization_id = ${id}`,
    );
    const prefs = await db.execute(
      sql`select count(*)::int as n from monthly_report_preferences where organization_id = ${id}`,
    );
    expect((reports.rows[0] as { n: number }).n).toBe(0);
    expect((prefs.rows[0] as { n: number }).n).toBe(0);
  });
});

describe("monthly_report_preferences", () => {
  it("holds one preference per organization", async () => {
    const { id } = await org();
    await db.insert(monthlyReportPreferences).values({ organizationId: id });
    await expect(db.insert(monthlyReportPreferences).values({ organizationId: id })).rejects.toThrow();
  });
});
