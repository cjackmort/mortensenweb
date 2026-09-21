import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  BUILD_COMMITMENT_MONTHS,
  BUILD_PRICE_CENTS,
  BUILD_WITH_CARE_CENTS,
  OVERAGE_CENTS,
  PLANS,
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

  it("returns the overage and build prices the pricing page quotes", async () => {
    const body = await GET().json();
    expect(body.overageCents).toBe(OVERAGE_CENTS);
    expect(body.build).toEqual({
      priceCents: BUILD_PRICE_CENTS,
      withCareCents: BUILD_WITH_CARE_CENTS,
      commitmentMonths: BUILD_COMMITMENT_MONTHS,
    });
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
