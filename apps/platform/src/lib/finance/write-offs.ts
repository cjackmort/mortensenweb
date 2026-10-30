import type { LedgerCategory } from "@/db/repositories/admin/finance";

/**
 * "Potential write-offs" for a year: what the operator might hand a CPA.
 *
 * Two kinds of line. Recorded expenses are money that went out and are the
 * ordinary deduction. Sites built for free are not money at all: they are
 * the operator's own unpaid work, valued at the usual build price, and are
 * listed because the operator asked for them to be — with a warning on each,
 * and the total shown both with and without them, so the number a CPA is
 * likely to accept is never hidden inside one that includes them.
 */

/** Shown on every free-site row. Not legal advice; a prompt to ask. */
export const CPA_WARNING =
  "Confirm with your CPA before claiming: the IRS generally doesn't allow deducting the value of your own unpaid work.";

export interface CategoryTotal {
  category: LedgerCategory;
  count: number;
  totalCents: number;
}

export interface FreeBuild {
  clientPublicId: string;
  organizationName: string;
  valueCents: number;
  /** `YYYY-MM-DD`. */
  builtOn: string;
}

export interface WriteOffSummary {
  year: number;
  /** Largest first. */
  categories: CategoryTotal[];
  expensesCents: number;
  /** Oldest first. */
  freeBuilds: FreeBuild[];
  freeBuildsCents: number;
  totalWithFreeBuildsCents: number;
  totalWithoutFreeBuildsCents: number;
}

export function summarizeWriteOffs(
  year: number,
  categories: CategoryTotal[],
  freeBuilds: FreeBuild[],
): WriteOffSummary {
  const expensesCents = categories.reduce((sum, c) => sum + c.totalCents, 0);
  const freeBuildsCents = freeBuilds.reduce((sum, b) => sum + b.valueCents, 0);
  return {
    year,
    categories: [...categories].sort((a, b) => b.totalCents - a.totalCents),
    expensesCents,
    freeBuilds: [...freeBuilds].sort((a, b) => a.builtOn.localeCompare(b.builtOn)),
    freeBuildsCents,
    totalWithFreeBuildsCents: expensesCents + freeBuildsCents,
    totalWithoutFreeBuildsCents: expensesCents,
  };
}
