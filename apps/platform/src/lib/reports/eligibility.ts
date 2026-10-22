import { PLANS, planIncludes, type PlanKey } from "@mortensenweb/plans";

/**
 * Who gets a monthly report: Care and every plan above it.
 *
 * Read from `@mortensenweb/plans` by key, like Growth access, so moving a
 * client between plans changes what they get without a stored flag to forget.
 * A comp counts as every plan, matching `lib/growth/access.ts`. A key the
 * package does not know (the $1 test plan, a retired key) includes nothing.
 */
export const REPORT_FROM: PlanKey = "care";

function isPlanKey(value: string | null | undefined): value is PlanKey {
  return PLANS.some((plan) => plan.key === value);
}

export function includesMonthlyReport(input: { planKey: string | null; comped: boolean }): boolean {
  if (input.comped) return true;
  return isPlanKey(input.planKey) && planIncludes(input.planKey, REPORT_FROM);
}

/**
 * Whether our work on a client is paused, which also pauses their report.
 *
 * A report is an account of the work we did for them that month; while the
 * work is paused (non-payment, usually) there is none to report, and an
 * upbeat email about their traffic in the middle of a payment dispute reads
 * badly. Their plan can still be active, so this is checked on its own.
 *
 * Either column counts. The pause sets both and payment clears both, but a
 * hand edit that sets only one must still stop the report. `at_risk` is not
 * paused: reminders have gone out and we are still working on the site.
 */
export function isManagementPaused(input: {
  managementState: string;
  managementPausedAt: Date | null;
}): boolean {
  return input.managementState === "unmanaged" || input.managementPausedAt !== null;
}
