import type { AdPlatform } from "@mortensenweb/plans";

/**
 * Where an ad was seen, in one vocabulary for both platforms.
 *
 * Google reports a network (`segments.ad_network_type`); Meta reports a
 * platform and a position (`publisher_platform`, `platform_position`). Both
 * are mapped to the keys below before they are stored, so the report reads
 * one list and the operator's dashboard can add Google and Meta together.
 *
 * A value either platform adds later is kept under its own name rather than
 * dropped: a new placement showing up as "instagram threads feed" is better
 * than impressions that silently vanish from the breakdown.
 */

export interface Placement {
  key: string;
  label: string;
  platform: AdPlatform;
}

const KNOWN: Record<string, Omit<Placement, "key">> = {
  google_search: { label: "Google Search", platform: "google_ads" },
  search_partners: { label: "Google search partners", platform: "google_ads" },
  google_maps: { label: "Google Maps", platform: "google_ads" },
  youtube: { label: "YouTube", platform: "google_ads" },
  display_network: { label: "Display network", platform: "google_ads" },
  gmail: { label: "Gmail", platform: "google_ads" },
  discover: { label: "Google Discover", platform: "google_ads" },
  google_tv: { label: "Google TV", platform: "google_ads" },
  google_mixed: { label: "Across Google (Performance Max)", platform: "google_ads" },
  google_owned: { label: "Google-owned sites", platform: "google_ads" },

  facebook_feed: { label: "Facebook Feed", platform: "meta" },
  facebook_stories: { label: "Facebook Stories", platform: "meta" },
  facebook_reels: { label: "Facebook Reels", platform: "meta" },
  facebook_marketplace: { label: "Facebook Marketplace", platform: "meta" },
  facebook_video_feeds: { label: "Facebook video feeds", platform: "meta" },
  facebook_right_column: { label: "Facebook right column", platform: "meta" },
  facebook_search: { label: "Facebook search results", platform: "meta" },
  facebook_instream: { label: "Facebook in-stream video", platform: "meta" },
  instagram_feed: { label: "Instagram Feed", platform: "meta" },
  instagram_stories: { label: "Instagram Stories", platform: "meta" },
  instagram_reels: { label: "Instagram Reels", platform: "meta" },
  instagram_explore: { label: "Instagram Explore", platform: "meta" },
  instagram_profile: { label: "Instagram profile feed", platform: "meta" },
  messenger: { label: "Messenger", platform: "meta" },
  audience_network: { label: "Audience Network", platform: "meta" },
  threads: { label: "Threads", platform: "meta" },
};

const GOOGLE_NETWORKS: Record<string, string> = {
  SEARCH: "google_search",
  SEARCH_PARTNERS: "search_partners",
  CONTENT: "display_network",
  YOUTUBE: "youtube",
  // Retired in favour of YOUTUBE, still read so an old row maps the same way.
  YOUTUBE_SEARCH: "youtube",
  YOUTUBE_WATCH: "youtube",
  MAPS: "google_maps",
  GMAIL: "gmail",
  DISCOVER: "discover",
  GOOGLE_TV: "google_tv",
  MIXED: "google_mixed",
  GOOGLE_OWNED_CHANNELS: "google_owned",
};

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/** `segments.ad_network_type` to a placement key. */
export function googlePlacement(adNetworkType: string | null | undefined): string {
  const raw = (adNetworkType ?? "UNKNOWN").toUpperCase();
  return GOOGLE_NETWORKS[raw] ?? `google_${slug(raw)}`;
}

/** Meta's `publisher_platform` and `platform_position` to a placement key. */
export function metaPlacement(platform: string | null | undefined, position: string | null | undefined): string {
  const p = slug(platform ?? "unknown");
  const where = slug(position ?? "");

  if (p === "messenger") return "messenger";
  if (p === "audience_network") return "audience_network";
  if (p === "threads") return "threads";

  if (p === "instagram") {
    if (where === "stream" || where === "feed") return "instagram_feed";
    if (where === "story" || where === "instagram_stories") return "instagram_stories";
    if (where === "reels" || where === "instagram_reels" || where === "instagram_reels_overlay") return "instagram_reels";
    if (where.startsWith("instagram_explore") || where === "explore") return "instagram_explore";
    if (where === "instagram_profile_feed" || where === "profile_feed") return "instagram_profile";
  }

  if (p === "facebook") {
    if (where === "feed") return "facebook_feed";
    if (where === "story" || where === "facebook_stories") return "facebook_stories";
    if (where === "facebook_reels" || where === "facebook_reels_overlay" || where === "reels") return "facebook_reels";
    if (where === "marketplace") return "facebook_marketplace";
    if (where === "video_feeds") return "facebook_video_feeds";
    if (where === "right_hand_column") return "facebook_right_column";
    if (where === "search") return "facebook_search";
    if (where === "instream_video") return "facebook_instream";
  }

  return where ? `${p}_${where}` : p;
}

export function placementFor(key: string): Placement {
  const known = KNOWN[key];
  if (known) return { key, ...known };
  const platform: AdPlatform = key.startsWith("google_") ? "google_ads" : "meta";
  const words = key.replace(/_/g, " ");
  return { key, label: words.charAt(0).toUpperCase() + words.slice(1), platform };
}
