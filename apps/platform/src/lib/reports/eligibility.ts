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
