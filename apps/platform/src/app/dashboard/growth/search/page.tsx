import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { requireGrowthFeature } from "@/db/repositories/client/growth";
import { getSearchView, type SearchTrendPoint, type SearchView } from "@/db/repositories/client/search-snapshots";
import { BackToGrowth } from "@/components/back-link";
import { Delta } from "@/components/analytics-summary";
import { Sparkline } from "@/components/charts";
import type { SearchSnapshot } from "@/lib/connections/providers/google";
import {
  dailySeries,
  formatCount,
  formatPosition,
  formatRate,
  formatWindow,
  rankQueries,
  searchHeadline,
} from "@/lib/search/format";
import { formatDate, formatDateTime } from "@/lib/time";
import { RefreshControls } from "./controls";

/**
 * Search: what people typed into Google to find the site, how often it was
 * shown, how often it was clicked, and where it ranked — the last 28 days,
 * from the client's own Search Console through the Google account they
 * connected under Connections.
 *
 * The page reads the portal's daily snapshot, never Google directly, and
 * says how old it is. Before Google is connected there is nothing of theirs
 * to show, so it says what to do. When the last read failed it says so: an
 * empty table would read as "nobody searched", which is the one thing a
 * failed call must never say.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Search",
  robots: { index: false, follow: false },
};

const CONNECT_HREF = "/dashboard/connections#google";

export default async function SearchPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.organizationId) {
    return (
      <main className="shell">
        <p className="notice">Your account is not linked to an organization yet. Please contact us.</p>
      </main>
    );
  }

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  if (!(await requireGrowthFeature(db, ctx, "search"))) {
    redirect("/dashboard/growth?locked=search#search");
  }

  const view = await getSearchView(db, ctx);
  const readOnly = ctx.impersonating;

  return (
    <main className="shell">
      <BackToGrowth />
      <div className="masthead">
        <h1>Search</h1>
        <span>What people search on Google to find you, and where you rank</span>
      </div>

      <Body view={view} readOnly={readOnly} />
    </main>
  );
}

function Body({ view, readOnly }: { view: SearchView; readOnly: boolean }) {
  switch (view.state) {
    case "not_connected":
      return <ConnectFirst />;
    case "needs_reconnect":
      return (
        <section className="panel" aria-labelledby="search-reconnect">
          <div className="panel-head">
            <h2 id="search-reconnect">Google needs connecting again</h2>
          </div>
          <div className="panel-body">
            <p>
              Google stopped accepting our connection{view.connectedAs ? ` for ${view.connectedAs}` : ""}. That
              happens when a password changes or access is removed. Connecting again takes a minute.
            </p>
            <Link className="button" href={CONNECT_HREF}>
              Connect Google again
            </Link>
          </div>
        </section>
      );
    case "pending":
      return (
        <section className="panel" aria-labelledby="search-pending">
          <div className="panel-head">
            <h2 id="search-pending">First look on its way</h2>
          </div>
          <div className="panel-body">
            <p>
              Google is connected{view.connectedAs ? ` as ${view.connectedAs}` : ""}. We read Search Console once a
              day; the first figures show here within a few hours, or now if you like.
            </p>
            <RefreshControls readOnly={readOnly} label="Read Google now" />
          </div>
        </section>
      );
    case "failed":
      return (
        <section className="panel" aria-labelledby="search-failed">
          <div className="panel-head">
            <h2 id="search-failed">Google could not be read</h2>
          </div>
          <div className="panel-body">
            <p className="notice notice-warning" role="status">
              We tried {formatDateTime(view.attemptedAt)} and Search Console did not answer, so there are no
              figures to show yet. This is on Google&apos;s side or ours, not something you did; we try again within six
              hours.
            </p>
            <p className="hint">What Google said: {view.error}</p>
            <RefreshControls readOnly={readOnly} label="Try again now" />
          </div>
        </section>
      );
    case "ready":
      return <Ready view={view} readOnly={readOnly} />;
  }
}

function ConnectFirst() {
  return (
    <section className="panel" aria-labelledby="search-connect">
      <div className="panel-head">
        <h2 id="search-connect">Connect Google first</h2>
      </div>
      <div className="panel-body">
        <p>
          These figures come from your own Google Search Console: the searches that showed your site, how many
          people clicked, and your average position. To read them we need a read-only connection to the Google
          account that owns the site in Search Console.
        </p>
        <p className="hint">
          We read search figures only — never Gmail, never your files — and you can disconnect at any time.
        </p>
        <Link className="button" href={CONNECT_HREF}>
          Connect Google
        </Link>
      </div>
    </section>
  );
}

function Ready({ view, readOnly }: { view: Extract<SearchView, { state: "ready" }>; readOnly: boolean }) {
  const { snapshot, fetchedAt, staleError, trend } = view;

  return (
    <>
      {staleError && (
        <p className="notice notice-warning" role="status">
          Our latest read of Search Console, {formatDateTime(staleError.attemptedAt)}, failed; the figures below are
          from {formatDateTime(fetchedAt)}. We try again within six hours.
        </p>
      )}

      {snapshot.property ? (
        <Figures snapshot={{ ...snapshot, property: snapshot.property }} trend={trend} />
      ) : (
        <NotInSearchConsole snapshot={snapshot} />
      )}

      <section className="panel" aria-labelledby="search-queries">
        <div className="panel-head">
          <h2 id="search-queries">What people searched</h2>
          <span className="panel-sub">{formatWindow(snapshot.startDate, snapshot.endDate)}</span>
        </div>
        {snapshot.property ? <QueryTable snapshot={snapshot} /> : null}
      </section>

      <p className="panel-note">
        Read from Google {formatDateTime(fetchedAt)}. Google&apos;s figures run a couple of days behind, and it leaves
        out searches made only a few times.
      </p>
      <RefreshControls readOnly={readOnly} />
    </>
  );
}

/** Change as a fraction, the way `Delta` takes it; null when there is nothing to compare with. */
function fraction(current: number, previous: number): number | null {
  return previous > 0 ? (current - previous) / previous : null;
}

function Figures({ snapshot, trend }: { snapshot: SearchSnapshot & { property: string }; trend: SearchTrendPoint[] }) {
  const { totals, previous } = snapshot;
  const window = { startDate: snapshot.startDate, endDate: snapshot.endDate };
  const impressionsByDay = dailySeries(snapshot.daily, window, (d) => d.impressions);
  const clicksByDay = dailySeries(snapshot.daily, window, (d) => d.clicks);
  // Position has no previous window from Google; the earliest snapshot we hold is the comparison.
  const earliest = trend.length > 1 ? trend[0]! : null;
  const positionChange = earliest && earliest.position > 0 ? fraction(totals.position, earliest.position) : null;

  return (
    <section className="panel" aria-labelledby="search-headline">
      <div className="panel-body">
        <p className="search-headline" id="search-headline">
          {searchHeadline(totals)}
        </p>
        <p className="hint">
          {formatWindow(snapshot.startDate, snapshot.endDate)} · in Google results for {snapshot.property.replace(/^sc-domain:/, "")}
        </p>
      </div>
      <div className="metrics">
        <Metric
          label="Shown in results"
          value={formatCount(totals.impressions)}
          change={fraction(totals.impressions, previous.impressions)}
          higherIsBetter
          spark={impressionsByDay}
          sparkId="search-spark-impressions"
          note="Times your site appeared on a Google results page"
        />
        <Metric
          label="Clicks"
          value={formatCount(totals.clicks)}
          change={fraction(totals.clicks, previous.clicks)}
          higherIsBetter
          spark={clicksByDay}
          sparkId="search-spark-clicks"
          note="Visits from those results"
        />
        <Metric label="Click rate" value={formatRate(totals.ctr)} note="Clicks for every hundred times shown" />
        <Metric
          label="Average position"
          value={formatPosition(totals.position)}
          change={positionChange}
          higherIsBetter={false}
          comparedTo={earliest ? `figures from ${formatDate(`${earliest.takenOn}T12:00:00Z`)}` : undefined}
          note="1 is the top of page one; lower is better. Page one ends around 10."
        />
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  note,
  change,
  higherIsBetter,
  comparedTo = "four weeks before",
  spark,
  sparkId,
}: {
  label: string;
  value: string;
  note: string;
  change?: number | null;
  higherIsBetter?: boolean;
  comparedTo?: string;
  spark?: number[];
  sparkId?: string;
}) {
  return (
    <div className="metric">
      <p className="metric-label">{label}</p>
      <div className="metric-main">
        <div className="metric-figure">
          <p className="metric-value">{value}</p>
          {change !== undefined && <Delta change={change} higherIsBetter={higherIsBetter} comparedTo={comparedTo} />}
        </div>
        {spark && sparkId && (
          <div className="metric-spark">
            <Sparkline values={spark} id={sparkId} />
          </div>
        )}
      </div>
      <p className="metric-note">{note}</p>
    </div>
  );
}

function QueryTable({ snapshot }: { snapshot: SearchSnapshot }) {
  const queries = rankQueries(snapshot.queries);
  if (queries.length === 0) {
    return (
      <div className="panel-body">
        <p className="muted">
          {snapshot.totals.impressions > 0
            ? "Google showed your site but did not share which searches: it hides searches made only a few times."
            : "No searches showed your site in these 28 days. If the site is new, Google may not have indexed it yet; ask us to check."}
        </p>
      </div>
    );
  }
  return (
    <div className="panel-body">
      <div className="table-wrap">
        <table className="stack">
          <caption className="sr-only">
            Searches that showed your site, with how often, clicks and average position
          </caption>
          <thead>
            <tr>
              <th scope="col">Search</th>
              <th scope="col">Shown</th>
              <th scope="col">Clicks</th>
              <th scope="col">Position</th>
            </tr>
          </thead>
          <tbody>
            {queries.map((q) => (
              <tr key={q.key}>
                <td data-label="Search">{q.key}</td>
                <td data-label="Shown">{formatCount(q.impressions)}</td>
                <td data-label="Clicks">{formatCount(q.clicks)}</td>
                <td data-label="Position">{formatPosition(q.position)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">The 25 searches that showed your site most often. Position is the average spot in the results.</p>
    </div>
  );
}

function NotInSearchConsole({ snapshot }: { snapshot: SearchSnapshot }) {
  const n = snapshot.properties.length;
  return (
    <section className="panel" aria-labelledby="search-noproperty">
      <div className="panel-head">
        <h2 id="search-noproperty">Your site is not in this Google account&apos;s Search Console</h2>
      </div>
      <div className="panel-body">
        <p>
          {n > 0
            ? `The Google account you connected sees ${n} site${n === 1 ? "" : "s"} in Search Console, and none of them is yours.`
            : "The Google account you connected has no sites in Search Console."}{" "}
          Either add your site at search.google.com/search-console (we can put the verification record on the site
          for you — just ask), or connect the Google account that already owns it.
        </p>
        <Link className="button secondary" href={CONNECT_HREF}>
          Connect a different Google account
        </Link>
      </div>
    </section>
  );
}
