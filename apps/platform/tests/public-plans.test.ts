import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  BUILDS,
  GROWTH_FEATURES,
  OVERAGE_CENTS,
  PLANS,
  upgradeBeatsAddOns,
  type PlanKey,
} from "@mortensenweb/plans";
import { GET } from "@/app/api/plans/route";
import { proxy } from "@/proxy";

/**
 * The price list the public site builds from.
 *
 * mortensenweb.com lives in its own repository and cannot import
 * `@mortensenweb/plans` any more, so it fetches this at build time. The point
 * of the package — the site and the portal quoting the same numbers — now
 * depends on this endpoint returning the package exactly, and on it being
 * reachable without a session, because a build server has none.
 */

const PORTAL = "https://portal.mortensenweb.com";

describe("GET /api/plans", () => {
  it("returns the plans exactly as the package defines them", async () => {
    const response = GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.plans).toEqual(PLANS);
  });

  it("returns the overage, Growth features and builds the pricing page quotes", async () => {
    const body = await GET().json();
    expect(body.overageCents).toBe(OVERAGE_CENTS);
    expect(body.growthFeatures).toEqual(GROWTH_FEATURES);
    expect(body.builds).toEqual(BUILDS);
  });

  it("never lists the complimentary plan", async () => {
    const body = await GET().json();
    const keys = body.plans.map((plan: { key: string }) => plan.key);
    expect(keys).not.toContain("comp-unlimited");
  });
});

describe("the proxy", () => {
  it("serves /api/plans to a caller with no session", () => {
    const response = proxy(new NextRequest(`${PORTAL}/api/plans`));
    expect(response.headers.get("location")).toBeNull();
  });

  it("still sends a lookalike path to sign-in", () => {
    const response = proxy(new NextRequest(`${PORTAL}/api/plans-admin`));
    expect(response.headers.get("location")).toBe(`${PORTAL}/login`);
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

  it("keeps Lite's add-on routes within $10 of the plan that also brings unlimited changes", () => {
    // From Lite, add-ons can come in just under the next plan — $25 + $15 for
    // the inbox against Care's $50, or $95 against Growth's $100. Allowed,
    // because the plan also brings unlimited changes, which are never sold as
    // an add-on; this holds the gap small enough that the upgrade stays the
    // obvious buy.
    for (const target of ["care", "growth", "pro"] as PlanKey[]) {
      const { saves } = upgradeBeatsAddOns("lite", target);
      expect(saves, `lite -> ${target}`).toBeGreaterThanOrEqual(-1000);
    }
  });

  it("puts every Growth feature together at more than $100 a month", () => {
    const total = GROWTH_FEATURES.reduce((sum, f) => sum + f.addOnCents, 0);
    expect(total).toBeGreaterThan(10000);
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

  it("prices the three builds at $100, $500 and $1,000", () => {
    expect(BUILDS.map((b) => [b.key, b.priceCents])).toEqual([
      ["launch", 10000],
      ["revamp", 50000],
      ["established", 100000],
    ]);
  });
});
