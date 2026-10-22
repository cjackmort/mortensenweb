import { z } from "zod";

/**
 * The monthly report, as stored in `monthly_reports.data`.
 *
 * Defined as a schema rather than only a type because the stored JSON is read
 * back months later, possibly by code that has moved on: a report that fails
 * to parse renders as "this report could not be read" instead of a page that
 * throws or, worse, shows a field it misread as zero.
 *
 * ## The rule every section follows
 *
 * A section is either `ok`, with figures the portal actually holds, or
 * `missing`, with the reason. Zero is a figure; "analytics not connected" is
 * not, and the two are never allowed to look alike. A missing section is
 * rendered as a sentence, never as a 0.
 */

export const REPORT_VERSION = 1;

export const MISSING_REASONS = [
  /** The portal has no analytics account configured at all. */
  "analytics_not_configured",
  /** The portal has one; this site is not attached to it. */
  "analytics_not_connected",
  /** The provider was configured and attached, and failed. */
  "analytics_error",
  /** The client has no website with us. */
  "no_site",
  /** The site's contact form does not deliver to the leads inbox. */
  "forms_not_connected",
  /** The site does not send the event this section counts. */
  "not_tracked",
  /** The section's own code failed. */
  "failed",
] as const;

export type MissingReason = (typeof MISSING_REASONS)[number];

const count = z.number().int().nonnegative();

const missing = z.object({
  state: z.literal("missing"),
  reason: z.enum(MISSING_REASONS),
});

const breakdown = z.object({ label: z.string(), value: count });

const visitors = z.object({
  state: z.literal("ok"),
  visitors: count,
  pageviews: count,
  /** The previous calendar month. Null when the comparison was unavailable. */
  previousVisitors: count.nullable(),
  /** Fraction (0.18 = up 18%). Null when there is nothing to compare against. */
  change: z.number().nullable(),
  topPages: z.array(breakdown),
  sources: z.array(breakdown),
});

export const CONTACT_EVENTS = ["phone_tapped", "email_tapped", "booking_opened"] as const;
export type ContactEvent = (typeof CONTACT_EVENTS)[number];

const contact = z.object({
  state: z.literal("ok"),
  /**
   * One row per contact link the site is known to track, including those
   * nobody tapped this month. A link the site has never reported is absent
   * rather than zero: "nobody tapped it" and "it is not tagged" are different.
   */
  rows: z.array(z.object({ id: z.enum(CONTACT_EVENTS), count })),
});

const enquiries = z.object({
  state: z.literal("ok"),
  received: count,
  /** Received in the previous month. */
  previous: count.nullable(),
  /** Of those received this month, how many the client has marked won. */
  won: count,
  /** Of those received this month, how many are still marked new. */
  awaitingReply: count,
});

const changes = z.object({
  items: z.array(z.object({ title: z.string(), completedAt: z.string() })),
});

const health = z.object({
  state: z.literal("ok"),
  live: z.boolean(),
  /** When the portal last fetched the live site and it answered. */
  lastConfirmedAt: z.string().nullable(),
  /** Live, and not confirmed online for more than two days when the report was made. */
  stale: z.boolean(),
});

/** A section contributed by a Growth feature. See `lib/reports/extensions.ts`. */
export const extraSectionSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  state: z.enum(["ok", "missing"]),
  /** A short phrase for the headline and the email ("4 new reviews"). */
  headline: z.string().nullable(),
  rows: z.array(z.object({ label: z.string(), value: z.string() })),
  /** A sentence under the rows. For a missing section, the reason. */
  note: z.string().nullable(),
});

export const reportDataSchema = z.object({
  version: z.literal(REPORT_VERSION),
  period: z.string(),
  label: z.string(),
  /** The previous month's name, for "up 18% on August". */
  previousMonthName: z.string(),
  startAt: z.string(),
  endAt: z.string(),
  businessName: z.string(),
  site: z.object({ name: z.string(), domain: z.string().nullable() }).nullable(),
  planName: z.string().nullable(),
  visitors: z.discriminatedUnion("state", [visitors, missing]),
  contact: z.discriminatedUnion("state", [contact, missing]),
  /** Null when the plan does not include the leads inbox: left out, not zero. */
  enquiries: z.discriminatedUnion("state", [enquiries, missing]).nullable(),
  changes,
  health: z.discriminatedUnion("state", [health, missing]),
  extras: z.array(extraSectionSchema),
  builtAt: z.string(),
});

export type MonthlyReportData = z.infer<typeof reportDataSchema>;
export type ExtraSection = z.infer<typeof extraSectionSchema>;
export type VisitorsSection = MonthlyReportData["visitors"];
export type ContactSection = MonthlyReportData["contact"];
export type EnquiriesSection = NonNullable<MonthlyReportData["enquiries"]>;
export type HealthSection = MonthlyReportData["health"];
export type Missing = z.infer<typeof missing>;

export function missingSection(reason: MissingReason): Missing {
  return { state: "missing", reason };
}

/** A stored report, or null when it cannot be read as this version. */
export function parseReportData(raw: unknown): MonthlyReportData | null {
  const parsed = reportDataSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
