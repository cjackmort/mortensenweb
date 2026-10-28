import type { GrowthFeatureKey } from "@mortensenweb/plans";
import type { Database } from "@/db/client";
import type { ReportWindow } from "./period";
import type { ExtraSection } from "./types";
import { CONNECTION_REPORT_EXTENSIONS } from "@/lib/connections/report";

/**
 * ===========================================================================
 * EXTENSION POINT: Growth features add their own section to the monthly report
 * ===========================================================================
 *
 * Ads, campaign tracking, review requests and the rest each know their own
 * month better than this module does. To put a section in every eligible
 * client's report, append one `ReportExtension` to `REPORT_EXTENSIONS`:
 *
 *     {
 *       key: "reviews",
 *       title: "Google reviews",
 *       feature: "reviews",
 *       async build({ db, organizationId, window }) {
 *         const n = await countNewReviews(db, organizationId, window);
 *         return {
 *           state: "ok",
 *           headline: `${n} new reviews`,
 *           rows: [{ label: "New reviews", value: String(n) }],
 *           note: null,
 *         };
 *       },
 *     }
 *
 * The rules:
 *
 *  - **Gated by `feature`.** The builder runs only when the client has that
 *    Growth feature (plan, add-on or comp). A plan that does not include it
 *    gets no section at all, not an empty one. Leave `feature` out for a
 *    section that depends on something other than the plan — a connected
 *    account, say — and gate it inside `build` by returning null.
 *  - **Scoped by `organizationId`.** It is the report's tenant; filter every
 *    query on it. `window` is the month, half-open, business timezone.
 *  - **Missing is not zero.** If the integration is not connected, return
 *    `state: "missing"` with the reason in `note`. Return null to leave the
 *    section out entirely (nothing happened and nothing is expected to).
 *  - **Throwing is contained.** A builder that throws becomes a section saying
 *    it could not be produced; the rest of the report still goes out.
 *
 * The page, the email and the headline render this shape generically, so a
 * new section needs no React and no email template.
 */

export interface ReportExtensionInput {
  db: Database;
  organizationId: string;
  window: ReportWindow;
  now: Date;
}

export type ExtensionSection = Omit<ExtraSection, "key" | "title">;

export interface ReportExtension {
  /** Stable identifier, also the section's anchor on the page. */
  key: string;
  /** The section heading. Used for the "could not be produced" fallback too. */
  title: string;
  /** The Growth feature a client must have for this section to appear. None: not plan-gated. */
  feature?: GrowthFeatureKey;
  build(input: ReportExtensionInput): Promise<ExtensionSection | null>;
}

export const REPORT_EXTENSIONS: ReportExtension[] = [...CONNECTION_REPORT_EXTENSIONS];
