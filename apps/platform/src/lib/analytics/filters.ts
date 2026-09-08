import type { EventCategory } from "./events";

/**
 * Filters, and the rules for reading them out of a URL.
 *
 * ## The rule that outranks the rest
 *
 * **No value here selects a site.** Every field is a filter *within* one site's
 * data, and the site is resolved server-side from the session — see
 * `analytics/resolve.ts`. A `websiteId` or `siteId` parameter is deliberately
 * absent from this module, because the moment one exists somebody will pass it
 * through to the provider and a client will be one URL edit away from another
 * client's figures.
 *
 * ## Why the filters are named after the provider's fields
 *
 * Umami's filter vocabulary is fixed — `path`, `referrer`, `device`, `country`,
 * `event`, `utmSource` and so on. Inventing portal-specific names would mean a
 * translation layer that has to be kept in step with a remote API nobody here
 * controls. These map one-to-one, and the unsupported ones are absent rather
 * than silently ignored.
 */

export const RANGE_PRESETS = {
  7: "Last 7 days",
  30: "Last 30 days",
  90: "Last 90 days",
} as const;

export type RangePreset = keyof typeof RANGE_PRESETS;

export function isRangePreset(value: unknown): value is RangePreset {
  return value === 7 || value === 30 || value === 90;
}

export interface DateWindow {
  startAt: number;
  endAt: number;
  /** Days covered, used to size the comparison window. */
  days: number;
  /**
   * True when the window runs to now and its last day is therefore partial.
   *
   * A dashboard that compares a part-finished day against whole ones reports a
   * decline every morning. The UI says so rather than pretending otherwise.
   */
  includesIncompleteDay: boolean;
}

export interface AnalyticsFilters {
  /** Preset, or `custom` when explicit dates were supplied. */
  range: RangePreset | "custom";
  /** Only meaningful when `range` is `custom`. ISO dates, site timezone. */
  customStart?: string;
  customEnd?: string;
  /** Compare against the immediately preceding window of equal length. */
  compare: boolean;

  // --- Provider-supported dimensions --------------------------------------
  path?: string;
  referrer?: string;
  device?: string;
  country?: string;
  utmSource?: string;
  utmCampaign?: string;

  /**
   * Narrows the event panels only, never the traffic figures.
   *
   * Umami filters events by *name*; a category is our grouping, not theirs, so
   * this cannot be pushed into the provider query. It is applied after
   * classification, and the UI has to say that it applies to one panel — a
   * filter that silently governs part of a page is worse than no filter.
   */
  eventCategory?: EventCategory;
}

export const EMPTY_FILTERS: AnalyticsFilters = { range: 30, compare: true };

/**
 * Which filters reach the provider, and which are applied here.
 *
 * Stated as data so the UI can label them without duplicating the knowledge.
 */
export const FILTER_SCOPE = {
  path: "provider",
  referrer: "provider",
  device: "provider",
  country: "provider",
  utmSource: "provider",
  utmCampaign: "provider",
  eventCategory: "events_panel_only",
} as const;

const MAX_VALUE_LENGTH = 200;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Accept a filter value, or reject it.
 *
 * Length-bounded and stripped of control characters. These end up in a query
 * string to a third party and in a cache key; an unbounded value is a way to
 * make both misbehave.
 */
function cleanValue(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.slice(0, MAX_VALUE_LENGTH);
}

const EVENT_CATEGORIES: EventCategory[] = [
  "contact_intent",
  "confirmed_inquiry",
  "content_interest",
  "navigation",
  "other",
];

/**
 * Read filters out of a URL.
 *
 * Anything unrecognised is dropped rather than passed through. A URL is
 * attacker-controlled input, and the set of things this returns is exactly the
 * set the rest of the code knows how to handle.
 */
export function parseFilters(
  params: Record<string, string | string[] | undefined>,
): AnalyticsFilters {
  const single = (key: string): string | undefined => {
    const value = params[key];
    return cleanValue(Array.isArray(value) ? value[0] : value);
  };

  const rangeRaw = single("range");
  const customStart = single("from");
  const customEnd = single("to");

  let range: AnalyticsFilters["range"] = 30;
  if (rangeRaw === "custom" && customStart && customEnd) {
    range = "custom";
  } else if (rangeRaw !== undefined) {
    const asNumber = Number(rangeRaw);
    if (isRangePreset(asNumber)) range = asNumber;
  }

  // Custom dates must both be present, well-formed, and in order. A half-valid
  // pair falls back to the default rather than producing a window nobody meant.
  const validCustom =
    range === "custom" &&
    customStart !== undefined &&
    customEnd !== undefined &&
    ISO_DATE.test(customStart) &&
    ISO_DATE.test(customEnd) &&
    customStart <= customEnd;

  const categoryRaw = single("events");
  const eventCategory = EVENT_CATEGORIES.includes(categoryRaw as EventCategory)
    ? (categoryRaw as EventCategory)
    : undefined;

  return {
    range: validCustom ? "custom" : range === "custom" ? 30 : range,
    customStart: validCustom ? customStart : undefined,
    customEnd: validCustom ? customEnd : undefined,
    // Comparison is on unless explicitly turned off.
    compare: single("compare") !== "off",
    path: single("path"),
    referrer: single("referrer"),
    device: single("device"),
    country: single("country"),
    utmSource: single("utm_source"),
    utmCampaign: single("utm_campaign"),
    eventCategory,
  };
}

/**
 * Render filters back into a query string.
 *
 * Only non-default values are written, so a clean view has a clean URL and the
 * "reset" control has something obvious to return to.
 */
export function serialiseFilters(filters: AnalyticsFilters): string {
  const params = new URLSearchParams();

  if (filters.range === "custom" && filters.customStart && filters.customEnd) {
    params.set("range", "custom");
    params.set("from", filters.customStart);
    params.set("to", filters.customEnd);
  } else if (filters.range !== 30) {
    params.set("range", String(filters.range));
  }

  if (!filters.compare) params.set("compare", "off");
  if (filters.path) params.set("path", filters.path);
  if (filters.referrer) params.set("referrer", filters.referrer);
  if (filters.device) params.set("device", filters.device);
  if (filters.country) params.set("country", filters.country);
  if (filters.utmSource) params.set("utm_source", filters.utmSource);
  if (filters.utmCampaign) params.set("utm_campaign", filters.utmCampaign);
  if (filters.eventCategory) params.set("events", filters.eventCategory);

  const query = params.toString();
  return query ? `?${query}` : "";
}

/** True when anything is narrowing the view. Drives the reset control. */
export function hasActiveFilters(filters: AnalyticsFilters): boolean {
  return Boolean(
    filters.path ||
      filters.referrer ||
      filters.device ||
      filters.country ||
      filters.utmSource ||
      filters.utmCampaign ||
      filters.eventCategory ||
      filters.range !== 30 ||
      !filters.compare,
  );
}

/**
 * The dimension filters, as the provider expects them.
 *
 * `eventCategory` is absent by construction: it is ours, not Umami's, and
 * pushing a category name into their `event` filter would match nothing and
 * return an empty panel that looked like "no activity".
 */
export function providerParams(
  filters: AnalyticsFilters,
): Record<string, string> {
  const params: Record<string, string> = {};
  if (filters.path) params.path = filters.path;
  if (filters.referrer) params.referrer = filters.referrer;
  if (filters.device) params.device = filters.device;
  if (filters.country) params.country = filters.country;
  if (filters.utmSource) params.utmSource = filters.utmSource;
  if (filters.utmCampaign) params.utmCampaign = filters.utmCampaign;
  return params;
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/**
 * Turn filters into an absolute window, in the site's timezone.
 *
 * A custom range is inclusive of both dates: someone choosing 1 May to 7 May
 * means seven whole days, and an exclusive end would quietly drop the last one.
 */
export function resolveWindow(
  filters: AnalyticsFilters,
  timeZone: string,
  now: Date = new Date(),
): DateWindow {
  if (filters.range === "custom" && filters.customStart && filters.customEnd) {
    const startAt = zonedDayStart(filters.customStart, timeZone);
    const endAt = zonedDayStart(filters.customEnd, timeZone) + DAY_MS;
    const days = Math.max(1, Math.round((endAt - startAt) / DAY_MS));
    return {
      startAt,
      endAt: Math.min(endAt, now.getTime()),
      days,
      includesIncompleteDay: endAt > now.getTime(),
    };
  }

  const days = filters.range === "custom" ? 30 : filters.range;
  const endAt = now.getTime();
  return {
    startAt: endAt - days * DAY_MS,
    endAt,
    days,
    // A trailing window always ends mid-day.
    includesIncompleteDay: true,
  };
}

/** The equal-length window immediately before this one, with no overlap. */
export function previousWindow(window: DateWindow): DateWindow {
  const span = window.endAt - window.startAt;
  return {
    startAt: window.startAt - span,
    endAt: window.startAt,
    days: window.days,
    includesIncompleteDay: false,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Midnight on an ISO date, in the given timezone, as an epoch millisecond.
 *
 * Built by asking `Intl` what that instant looks like in the zone and
 * correcting by the difference, which handles daylight saving without a
 * timezone library. Getting this wrong shifts every figure by an hour twice a
 * year, in a way nobody notices until a client asks why a Monday moved.
 */
export function zonedDayStart(isoDate: string, timeZone: string): number {
  const [year, month, day] = isoDate.split("-").map(Number);
  const guess = Date.UTC(year!, month! - 1, day!, 0, 0, 0);
  const offset = zoneOffsetMs(guess, timeZone);
  return guess + offset;
}

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]),
  );

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    // `Intl` renders midnight as hour 24 in some zones rather than 0.
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );

  return utcMs - asUtc;
}

/**
 * A cache key that cannot collide across sites, windows, or filters.
 *
 * The website id leads, so a key can never be reused between tenants even if
 * every other component matches — which is the failure that would serve one
 * client another's figures out of a shared cache.
 */
export function cacheKey(
  websiteId: string,
  window: DateWindow,
  timeZone: string,
  filters: AnalyticsFilters,
): string {
  const dimensions = Object.entries(providerParams(filters))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  return [
    "umami",
    websiteId,
    window.startAt,
    window.endAt,
    timeZone,
    filters.compare ? "cmp" : "nocmp",
    dimensions || "nofilters",
  ].join("|");
}
