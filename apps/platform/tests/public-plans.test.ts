import { describe, expect, it } from "vitest";
import {
  ADD_ON_FEATURES,
  BUILDS,
  FREE_PORTAL,
  GROWTH_FEATURES,
  OVERAGE_CENTS,
  PLANS,
  upgradeBeatsAddOns,
  type PlanKey,
} from "@mortensenweb/plans";
import { GET } from "@/app/api/plans/route";

/**
 * The price list the public site builds from.
 *
 * mortensenweb.com lives in its own repository and cannot import
 * `@mortensenweb/plans` any more, so it fetches this at build time. The point
 * of the package — the site and the portal quoting the same numbers — now
 * depends on this endpoint returning the package exactly, and on it being
 * reachable without a session, because a build server has none. The handler
 * checks for none, and `route-auth.test.ts` lists it as public on purpose.
 */

describe("GET /api/plans", () => {
  it("returns the plans exactly as the package defines them", async () => {
    const response = GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.plans).toEqual(PLANS);
  });

  it("returns the overage, Growth features, builds and free portal the pricing page quotes", async () => {
    const body = await GET().json();
    expect(body.overageCents).toBe(OVERAGE_CENTS);
    expect(body.growthFeatures).toEqual(GROWTH_FEATURES);
    expect(body.builds).toEqual(BUILDS);
    expect(body.freePortal).toEqual(FREE_PORTAL);
  });

  it("never lists the complimentary plan", async () => {
    const body = await GET().json();
    const keys = body.plans.map((plan: { key: string }) => plan.key);
    expect(keys).not.toContain("comp-unlimited");
  });
});

/**
 * The ladder the 2026-10-06 prices were set to. A price edit that breaks one
 * of these quietly turns "upgrade" into the worse deal, or sells something
 * that is not built — so they are held here rather than left to the copy.
 */
describe("the price ladder", () => {
  const keys: PlanKey[] = ["lite", "care", "growth", "pro"];

  it("climbs: each plan costs more and includes everything below it", () => {
    for (let i = 1; i < keys.length; i += 1) {
      const lower = PLANS.find((p) => p.key === keys[i - 1])!;
      const higher = PLANS.find((p) => p.key === keys[i])!;
      expect(higher.monthlyCents).toBeGreaterThan(lower.monthlyCents);
      for (const feature of lower.growthFeatures) {
        expect(higher.growthFeatures, `${higher.key} keeps ${feature}`).toContain(feature);
      }
    }
  });

  it("makes upgrading cheaper than buying the next plan's features as add-ons, from Care up", () => {
    for (const [current, target] of [
      ["care", "growth"],
      ["care", "pro"],
      ["growth", "pro"],
    ] as Array<[PlanKey, PlanKey]>) {
      const { saves } = upgradeBeatsAddOns(current, target);
      expect(saves, `${current} -> ${target}`).toBeGreaterThan(0);
    }
  });

  it("keeps Lite's add-on routes within what unlimited changes cost", () => {
    // From Lite, add-ons can come in under the next plan — $80 against
    // Growth's $100. Allowed, because the plan also brings unlimited changes,
    // which are never sold as an add-on; this holds the gap to what Care adds
    // over Lite for exactly that, so the upgrade stays the obvious buy. (Until
    // 2026-10-21 the bound was $10, with the inbox a $15 add-on.)
    const unlimitedChanges =
      PLANS.find((p) => p.key === "care")!.monthlyCents - PLANS.find((p) => p.key === "lite")!.monthlyCents;
    for (const target of ["care", "growth", "pro"] as PlanKey[]) {
      const { saves } = upgradeBeatsAddOns("lite", target);
      expect(saves, `lite -> ${target}`).toBeGreaterThanOrEqual(-unlimitedChanges);
    }
  });

  it("puts every paid Growth feature together at more than $100 a month", () => {
    const total = ADD_ON_FEATURES.reduce((sum, f) => sum + f.addOnCents, 0);
    expect(total).toBeGreaterThan(10000);
  });

  it("gives the leads inbox to every plan and to the free portal", () => {
    expect(GROWTH_FEATURES.find((f) => f.key === "leads")!.includedFrom).toBe("free");
    expect(ADD_ON_FEATURES.map((f) => f.key)).not.toContain("leads");
    for (const plan of PLANS) expect(plan.growthFeatures, plan.key).toContain("leads");
    expect(FREE_PORTAL.monthlyCents).toBe(0);
    expect(FREE_PORTAL.features).toEqual(["Visitor analytics", "Leads inbox"]);
  });

  it("reserves unlimited changes for Care and above, never an add-on", () => {
    expect(PLANS.find((p) => p.key === "lite")!.includedChangesPerMonth).toBe(1);
    for (const key of ["care", "growth", "pro"]) {
      expect(PLANS.find((p) => p.key === key)!.includedChangesPerMonth).toBeNull();
    }
  });

  it("never lists an unbuilt feature on a plan without saying it is coming", () => {
    for (const feature of GROWTH_FEATURES.filter((f) => !f.available)) {
      for (const plan of PLANS) {
        for (const line of plan.features.filter((l) => l.startsWith(feature.name))) {
          expect(line, `${plan.key}: ${line}`).toMatch(/coming soon/);
        }
      }
    }
  });

  it("prices the build at $500, one price for every new site", () => {
    expect(BUILDS.map((b) => [b.key, b.priceCents])).toEqual([["website", 50000]]);
  });
});
