import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { organizations, sites } from "@/db/schema";
import { reverifyLiveSites } from "@/db/repositories/admin/launch";
import { newPublicId } from "@/lib/ids";
import type { UrlCheck } from "@/lib/netlify/api";
import { createTestDb } from "./helpers/db";

/**
 * The scheduled re-check of live sites.
 *
 * It used to fetch one site at a time, a hundred at most, in whatever order the
 * database returned them. With a ten-second timeout on each, a few hung sites
 * could run the endpoint out of its minute — and, with no order, the same
 * hundred got checked every tick while a site past the cap was never checked.
 *
 * What these protect:
 *  - the sites longest unchecked go first, never-checked ones before all;
 *  - no more than ten fetches are ever in flight;
 *  - a budget stops the run early, and the sites it did not reach lead the
 *    next one, so every site gets its turn;
 *  - a failing site is reported and is not marked as verified.
 */

let db: Database;
let close: () => Promise<void>;
let organizationId: string;

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
  const org = (
    await db
      .insert(organizations)
      .values({ publicId: newPublicId(), name: "Acme", slug: "acme", kind: "client" })
      .returning()
  )[0]!;
  organizationId = org.id;
});

afterAll(async () => {
  await close();
});

let startedAt: number;

beforeEach(async () => {
  await db.delete(sites);
  startedAt = Date.now();
});

const HOUR_MS = 60 * 60 * 1000;
const OK: UrlCheck = { ok: true, status: 200 };

/** Hours before now a site was last verified; `null` is never. */
async function seedSite(name: string, verifiedHoursAgo: number | null) {
  const [site] = await db
    .insert(sites)
    .values({
      publicId: newPublicId(),
      organizationId,
      name,
      status: "live",
      productionUrl: `https://${name}.test`,
      primaryDomain: `${name}.test`,
      liveVerifiedAt:
        verifiedHoursAgo === null ? null : new Date(Date.now() - verifiedHoursAgo * HOUR_MS),
    })
    .returning();
  return site!;
}

/** Was the site's verification time written during this test? */
async function wasStamped(name: string): Promise<boolean> {
  const [row] = await db
    .select({ at: sites.liveVerifiedAt })
    .from(sites)
    .where(eq(sites.name, name));
  return row!.at !== null && row!.at.getTime() >= startedAt;
}

describe("reverifyLiveSites", () => {
  it("checks never-verified sites first, then the longest unchecked", async () => {
    await seedSite("recent", 1);
    await seedSite("never", null);
    await seedSite("oldest", 200);
    await seedSite("middle", 48);

    const order: string[] = [];
    await reverifyLiveSites(db, {
      check: async (url) => {
        order.push(new URL(url).hostname);
        return OK;
      },
    });

    expect(order).toEqual(["never.test", "oldest.test", "middle.test", "recent.test"]);
  });

  it("never has more than ten fetches in flight", async () => {
    for (let i = 0; i < 25; i++) await seedSite(`site-${i}`, i);

    let inFlight = 0;
    let peak = 0;
    let checks = 0;
    await reverifyLiveSites(db, {
      check: async () => {
        inFlight++;
        checks++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return OK;
      },
    });

    expect(checks).toBe(25);
    expect(peak).toBe(10);
  });

  it("stops starting checks when the budget runs out, and the next run starts where it stopped", async () => {
    for (let i = 0; i < 8; i++) await seedSite(`site-${i}`, 100 - i);

    // Each check "takes" four seconds of a clock the test controls. A check
    // needs the ten-second timeout to fit in what is left of a 25-second
    // budget, so only the starts at 0s, 4s, 8s and 12s qualify; the one at
    // 16s would be allowed to run past it.
    let clock = 0;
    const first: string[] = [];
    await reverifyLiveSites(db, {
      budgetMs: 25_000,
      now: () => clock,
      check: async (url) => {
        first.push(new URL(url).hostname);
        clock += 4_000;
        return OK;
      },
    });

    expect(first).toEqual(["site-0.test", "site-1.test", "site-2.test", "site-3.test"]);
    expect(await wasStamped("site-3")).toBe(true);
    expect(await wasStamped("site-4")).toBe(false);

    // The four just checked are now the newest, so the four it never reached
    // are first in line.
    const second: string[] = [];
    await reverifyLiveSites(db, {
      check: async (url) => {
        second.push(new URL(url).hostname);
        return OK;
      },
    });
    expect(second.slice(0, 4)).toEqual(["site-4.test", "site-5.test", "site-6.test", "site-7.test"]);
  });

  it("reports a site that does not answer, and does not mark it verified", async () => {
    await seedSite("healthy", 10);
    await seedSite("down", 20);
    await seedSite("broken", 30);

    const problems = await reverifyLiveSites(db, {
      check: async (url) => {
        if (url.includes("down")) return { ok: false, reason: "unreachable" };
        if (url.includes("broken")) return { ok: false, reason: "server_error", status: 502 };
        return OK;
      },
    });

    // In the order the sites were checked, not the order they finished.
    expect(problems.map((p) => [p.domain, p.problem])).toEqual([
      ["broken.test", "responded 502"],
      ["down.test", "not reachable"],
    ]);
    expect(await wasStamped("down")).toBe(false);
    expect(await wasStamped("healthy")).toBe(true);
  });

  it("leaves out a live site that has no production URL", async () => {
    await seedSite("served", 5);
    await db.insert(sites).values({
      publicId: newPublicId(),
      organizationId,
      name: "no-url",
      status: "live",
    });

    const checked: string[] = [];
    await reverifyLiveSites(db, {
      check: async (url) => {
        checked.push(url);
        return OK;
      },
    });

    expect(checked).toEqual(["https://served.test"]);
  });
});
