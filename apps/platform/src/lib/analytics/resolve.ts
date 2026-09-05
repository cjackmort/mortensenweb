import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import type { TenantContext } from "@/db/repositories/context";
import { analyticsConnections, sites } from "@/db/schema";
import { demoAnalytics } from "./demo";
import {
  fetchAnalytics,
  isUmamiConfigured,
  type AnalyticsState,
  type AnalyticsSummary,
  type RangeDays,
} from "./umami";

/**
 * Resolve one tenant's analytics, from session to figures.
 *
 * Shared by the dashboard and the Visitors page so they cannot drift. That
 * matters more than saving a few lines: if one page resolved the site
 * differently from the other, the summary on the dashboard could disagree with
 * the detail page, and a client comparing the two would rightly stop trusting
 * both.
 *
 * The site is always resolved by the session's own `organizationId`, so
 * no caller can pass in a site id and read another organization's figures.
 */

export interface ResolvedAnalytics {
  site: { publicId: string; name: string; primaryDomain: string | null } | null;
  state: AnalyticsState;
  /** Real figures when `showingDemo` is false, stand-ins when it is true. */
  data: AnalyticsSummary;
  /** True when `data` is invented and must be labelled as such. */
  showingDemo: boolean;
  /** True when the *site itself* is seeded demo data. */
  isDemoSite: boolean;
}

export async function resolveClientAnalytics(
  db: Database,
  ctx: TenantContext,
  days: RangeDays,
): Promise<ResolvedAnalytics> {
  // The site and its analytics connection in one round trip. This used to be
  // `listSites` followed by a second query for the connection — two HTTPS
  // calls to Neon in sequence, on the page every client lands on. The join is
  // tenant-scoped exactly as `listSites` is: by `organizationId` from the
  // session context, never from a request.
  const rows = await db
    .select({
      publicId: sites.publicId,
      name: sites.name,
      primaryDomain: sites.primaryDomain,
      isDemo: sites.isDemo,
      umamiWebsiteId: analyticsConnections.umamiWebsiteId,
    })
    .from(sites)
    .leftJoin(analyticsConnections, eq(analyticsConnections.siteId, sites.id))
    .where(eq(sites.organizationId, ctx.organizationId))
    .orderBy(sites.name)
    .limit(1);

  const site = rows[0] ?? null;
  const websiteId = site?.umamiWebsiteId ?? null;
  const isDemoSite = site?.isDemo ?? false;

  let state: AnalyticsState;
  if (websiteId) {
    state = await fetchAnalytics(websiteId, days);
  } else if (!isUmamiConfigured()) {
    state = { kind: "not_configured" };
  } else {
    state = { kind: "not_connected" };
  }

  const showingDemo = state.kind !== "ok";

  return {
    site: site
      ? {
          publicId: site.publicId,
          name: site.name,
          primaryDomain: site.primaryDomain,
        }
      : null,
    state,
    data:
      state.kind === "ok"
        ? state.data
        : demoAnalytics(site?.publicId ?? ctx.organizationId, days),
    showingDemo,
    isDemoSite,
  };
}

/**
 * Why stand-in figures are on screen, in the client's language.
 *
 * Returns null when the data is real. Shared so the dashboard and the Visitors
 * page give the same explanation rather than two differently-worded ones.
 */
export function demoReason(state: AnalyticsState): string | null {
  switch (state.kind) {
    case "ok":
      return null;
    case "not_configured":
      return "Analytics is not connected yet — no analytics account is configured for the portal.";
    case "not_connected":
      return "This site has no analytics attached yet, so nothing is being recorded.";
    case "error":
      return `We could not reach the analytics service (${state.message}). This is our problem, not a drop in your traffic.`;
  }
}
