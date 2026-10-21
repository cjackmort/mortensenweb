import { NextResponse } from "next/server";
import {
  AD_CHANNELS,
  AD_DURATIONS_DAYS,
  AD_MANAGEMENT_FEE,
  AD_UNSPENT_POLICY,
  ADS_AVAILABLE,
  BUILDS,
  GROWTH_FEATURES,
  OVERAGE_CENTS,
  PLANS,
} from "@mortensenweb/plans";

/**
 * The care plans, for the public site's build.
 *
 * mortensenweb.com moved to its own repository so the portal's could go
 * private, and a separate repository cannot import `@mortensenweb/plans`. It
 * fetches this at build time instead, which keeps the package the one place a
 * price is set: the site and the portal still cannot quote different numbers.
 *
 * Public by design — every figure here is already on the pricing page — and
 * listed as public in tests/route-auth.test.ts, because a build server has no
 * session.
 * `comp-unlimited` is absent for the reason the package gives: it is granted,
 * never sold.
 *
 * Not cached: next.config.ts sends no-store on every /api route, and that
 * suits this one — a site build straight after a price change gets the new
 * price rather than a CDN's copy of the old one.
 */

export const dynamic = "force-static";

export function GET() {
  return NextResponse.json({
    plans: PLANS,
    growthFeatures: GROWTH_FEATURES,
    overageCents: OVERAGE_CENTS,
    // Three standalone builds since 2026-10-06, replacing `build` (one price
    // and a discount behind a twelve-month commitment). The standalone site
    // repository reads this at build time and must be updated with it.
    builds: BUILDS,
    // Paid ads, on every plan, per campaign. `available` is false until ads
    // can actually be launched; the pricing page should say nothing about
    // them until it is true, and then quote the fee from here.
    ads: {
      available: ADS_AVAILABLE,
      fee: AD_MANAGEMENT_FEE,
      channels: AD_CHANNELS,
      durationsDays: AD_DURATIONS_DAYS,
      unspentPolicy: AD_UNSPENT_POLICY,
    },
  });
}
