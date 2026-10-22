import { and, count, eq, gte, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { campaigns, campaignScans, sites, type CampaignPlacement, type ScanDevice } from "@/db/schema";
import { destinationUrl, siteOrigin } from "@/lib/campaigns/links";

/**
 * The short-link redirect, from the system's side.
 *
 * The person scanning has no session and never will, so nothing here takes
 * a context. What scopes a scan is the campaign the code resolved to: its
 * organization is copied from that row, never from anything in the
 * request.
 */

export interface RedirectTarget {
  campaignId: string;
  organizationId: string;
  /** Null when the site has lost its address; the route says so instead of guessing. */
  url: string | null;
  paused: boolean;
}

export async function findCampaignForRedirect(db: Database, code: string): Promise<RedirectTarget | null> {
  const [row] = await db
    .select({
      id: campaigns.id,
      organizationId: campaigns.organizationId,
      placement: campaigns.placement,
      destinationPath: campaigns.destinationPath,
      utmCampaign: campaigns.utmCampaign,
      pausedAt: campaigns.pausedAt,
      productionUrl: sites.productionUrl,
      primaryDomain: sites.primaryDomain,
    })
    .from(campaigns)
    .innerJoin(sites, eq(sites.id, campaigns.siteId))
    .where(eq(campaigns.code, code))
    .limit(1);
  if (!row) return null;

  const origin = siteOrigin(row);
  return {
    campaignId: row.id,
    organizationId: row.organizationId,
    url: origin
      ? destinationUrl({
          origin,
          path: row.destinationPath,
          placement: row.placement as CampaignPlacement,
          utmCampaign: row.utmCampaign,
        })
      : null,
    paused: row.pausedAt !== null,
  };
}

/** One phone scanning the same code again within this window is one scan. */
export const REPEAT_SCAN_WINDOW_MINUTES = 30;
/**
 * The most one visitor can add to a client's counts in a day, across all
 * their campaigns. Generous for a real person; a ceiling on anyone trying to
 * make a campaign look better or worse than it is.
 */
export const MAX_COUNTED_SCANS_PER_VISITOR_PER_DAY = 20;

export type ScanOutcome = "recorded" | "repeat" | "capped";

export interface ScanFacts {
  device: ScanDevice;
  city: string | null;
  region: string | null;
  country: string | null;
  visitorHash: string | null;
}

/**
 * Count a scan, unless it is the same visitor again or one over their cap.
 *
 * Without a visitor hash (no address or no key on this server) every scan
 * counts: overcounting a double scan is a smaller error than refusing to
 * count anyone.
 */
export async function recordScan(
  db: Database,
  target: RedirectTarget,
  facts: ScanFacts,
  now: Date = new Date(),
): Promise<ScanOutcome> {
  if (facts.visitorHash) {
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const repeatSince = new Date(now.getTime() - REPEAT_SCAN_WINDOW_MINUTES * 60 * 1000);
    const [seen] = await db
      .select({
        today: count(),
        repeats: sql<number>`count(*) filter (where ${campaignScans.campaignId} = ${target.campaignId} and ${campaignScans.scannedAt} >= ${repeatSince.toISOString()})`.mapWith(
          Number,
        ),
      })
      .from(campaignScans)
      .where(and(eq(campaignScans.visitorHash, facts.visitorHash), gte(campaignScans.scannedAt, dayAgo)));
    if ((seen?.repeats ?? 0) > 0) return "repeat";
    if ((seen?.today ?? 0) >= MAX_COUNTED_SCANS_PER_VISITOR_PER_DAY) return "capped";
  }

  await db.insert(campaignScans).values({
    campaignId: target.campaignId,
    organizationId: target.organizationId,
    scannedAt: now,
    device: facts.device,
    city: facts.city,
    region: facts.region,
    country: facts.country,
    visitorHash: facts.visitorHash,
  });
  return "recorded";
}
