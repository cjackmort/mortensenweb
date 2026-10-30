import type { PeriodTotals, ProfitStanding } from "@/db/repositories/admin/finance";
import { standingOf } from "@/lib/finance/standing";
import { formatCurrency } from "@/lib/payments/venmo";
import { monthName } from "./format";

/**
 * The first thing on Payments: are we ahead this month, and ahead overall?
 *
 * Green or red, but never colour alone: the words "In the green" / "In the
 * red" and the sign on the figure say the same thing for anyone who cannot
 * tell the two apart, or is reading a printout.
 */
export function StandingTiles({ standing }: { standing: ProfitStanding }) {
  const month = monthName(standing.month.yearMonth).split(" ")[0] ?? "This month";
  const since = standing.allTime.since;
  return (
    <div className="grid grid-2 pay-standing">
      <StandingTile label={`${month} so far`} totals={standing.month} />
      <StandingTile
        label="All time"
        totals={standing.allTime}
        when={since ? `since ${monthName(since.slice(0, 7))}` : "nothing recorded yet"}
      />
    </div>
  );
}

function StandingTile({ label, totals, when }: { label: string; totals: PeriodTotals; when?: string }) {
  const { tone, label: words } = standingOf(totals.profitCents);
  const sign = tone === "green" ? "+" : tone === "red" ? "−" : "";
  const out = totals.feesCents + totals.expensesCents;
  return (
    <a className={`stat pay-stat-link pay-standing-tile is-${tone}`} href="#ledger">
      <p className="stat-label">{label}</p>
      <p className="pay-standing-words">
        <span aria-hidden="true">{tone === "green" ? "▲" : tone === "red" ? "▼" : "■"}</span> {words}
      </p>
      <p className="stat-value">
        {sign}
        {formatCurrency(Math.abs(totals.profitCents))}
      </p>
      <p className="stat-note">
        {formatCurrency(totals.incomeCents)} in · {formatCurrency(out)} out
        {when && ` · ${when}`}
      </p>
    </a>
  );
}
