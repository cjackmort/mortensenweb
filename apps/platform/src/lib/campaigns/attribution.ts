import { classifyEvent, isPortalEvent } from "@/lib/analytics/events";
import { fetchUtmCampaignFigures, isUmamiConfigured } from "@/lib/analytics/umami";

/**
 * What each campaign brought to the client's website, from Umami.
 *
 * Scans are counted by the portal. Whether a scan became a visit, and the
 * visit became a tap on the phone number, is the site's own analytics
 * filtered by the `utm_campaign` the redirect added. Those are two
 * different systems, and the page keeps them visibly apart.
 *
 * Every state is explicit, as in `lib/analytics/umami.ts`: an account that
 * is not set up, a site with no website id and a service that failed each
 * render as their own message, never as a column of zeroes.
 */

export interface CampaignAttribution {
  visitors: number;
  /** Taps on a phone number, email address or booking link. Not calls. */
  reachedOut: number;
}

export type AttributionState =
  | { kind: "ok"; byUtm: Record<string, CampaignAttribution> }
  | { kind: "not_configured" }
  | { kind: "not_connected" }
  | { kind: "error"; message: string };

/**
 * Two Umami calls per campaign. Umami Cloud allows 50 calls in 15 seconds
 * and the dashboard's own load spends six, so the page asks about the
 * campaigns it is showing first — the caller passes them most-scanned first.
 */
export const MAX_ATTRIBUTED_CAMPAIGNS = 8;

export async function attributeCampaigns(
  targets: Array<{ utmCampaign: string; websiteId: string | null }>,
  window: { startAt: number; endAt: number },
): Promise<AttributionState> {
  if (!isUmamiConfigured()) return { kind: "not_configured" };
  const connected = targets.filter(
    (t): t is { utmCampaign: string; websiteId: string } => typeof t.websiteId === "string" && t.websiteId !== "",
  );
  if (connected.length === 0) return { kind: "not_connected" };

  try {
    const figures = await Promise.all(
      connected.slice(0, MAX_ATTRIBUTED_CAMPAIGNS).map(async (target) => {
        const result = await fetchUtmCampaignFigures(target.websiteId, target.utmCampaign, window);
        const reachedOut = result.events
          .filter((event) => !isPortalEvent(event.label))
          .map((event) => classifyEvent(event.label, event.value))
          .filter((event) => event.category === "contact_intent")
          .reduce((sum, event) => sum + event.count, 0);
        return [target.utmCampaign, { visitors: result.visitors, reachedOut }] as const;
      }),
    );
    return { kind: "ok", byUtm: Object.fromEntries(figures) };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : "Unknown error" };
  }
}
