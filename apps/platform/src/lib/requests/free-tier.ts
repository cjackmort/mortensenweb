import { FREE_SMALL_CHANGES_PER_MONTH, type ChangeSize } from "@mortensenweb/plans";
import { currentPeriod } from "@/lib/billing/period";

/**
 * What a client may ask for before they pay (decision D7).
 *
 * Until the build is paid, and with no plan, small changes are free —
 * `FREE_SMALL_CHANGES_PER_MONTH` a month — and big ones wait. Pure, so the
 * rule is the same on the page that explains it and in the action that
 * enforces it.
 */

export type FreeTierRefusal =
  | { reason: "needs_payment"; message: string }
  | { reason: "free_change_used"; message: string; resetsOn: string };

/** The first day of the next business month, `YYYY-MM-DD`. */
export function nextPeriodStart(at: Date = new Date()): string {
  const { end } = currentPeriod(at);
  const after = new Date(`${end}T12:00:00Z`);
  after.setUTCDate(after.getUTCDate() + 1);
  return after.toISOString().slice(0, 10);
}

/** "December 1", from `2026-12-01`. */
export function dayLabel(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

export function freeTierRefusal(input: { size: ChangeSize; used: number; at?: Date }): FreeTierRefusal | null {
  if (input.size === "big") {
    return {
      reason: "needs_payment",
      message:
        "Bigger changes — a new page or section, a new layout, something new the site should do — come with putting your site live or a care plan. Small changes are free until then.",
    };
  }
  if (input.used < FREE_SMALL_CHANGES_PER_MONTH) return null;

  const resetsOn = nextPeriodStart(input.at);
  return {
    reason: "free_change_used",
    resetsOn,
    message: `You've used this month's free small change. The next one opens on ${dayLabel(resetsOn)} — or put your site live, or choose a plan, for more.`,
  };
}
