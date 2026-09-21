import { NextResponse } from "next/server";
import {
  BUILD_COMMITMENT_MONTHS,
  BUILD_PRICE_CENTS,
  BUILD_WITH_CARE_CENTS,
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
 * listed in the proxy's PUBLIC_PATHS, because a build server has no session.
 * `comp-unlimited` is absent for the reason the package gives: it is granted,
 * never sold.
 *
 * Five minutes at the CDN. A site build a few minutes after a price change can
 * still see the old price; rebuild the site after changing one.
 */

const CDN_MAX_AGE_SECONDS = 300;

export const dynamic = "force-static";

export function GET() {
  return NextResponse.json(
    {
      plans: PLANS,
      overageCents: OVERAGE_CENTS,
      build: {
        priceCents: BUILD_PRICE_CENTS,
        withCareCents: BUILD_WITH_CARE_CENTS,
        commitmentMonths: BUILD_COMMITMENT_MONTHS,
      },
    },
    {
      headers: {
        "Cache-Control": `public, max-age=${CDN_MAX_AGE_SECONDS}`,
      },
    },
  );
}
