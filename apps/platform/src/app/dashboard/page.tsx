import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { DemoBanner, StatRow } from "@/components/analytics-summary";
import { BarList, SeriesTable } from "@/components/charts";
import { TimeSeriesChart } from "@/components/time-series-chart";
import { EventPanels } from "@/components/event-panels";
import { categoriseEvents } from "@/lib/analytics/events";
import { AnalyticsFilterBar } from "@/components/analytics-filters";
import {
  parseFilters,
  serialiseFilters,
  type AnalyticsFilters,
} from "@/lib/analytics/filters";
import { VisitorsSkeleton } from "@/components/skeletons";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { listPreviewsAwaitingDecision } from "@/db/repositories/client/previews";
import { resolveClientAnalytics } from "@/lib/analytics/resolve";
import {
  RANGES,
  isValidRange,
  type Breakdown,
  type RangeDays,
} from "@/lib/analytics/umami";
import { formatTime } from "@/lib/time";

export const dynamic = "force-dynamic";

/**
 * Client dashboard.
 *
 * Their website, and how it is doing. Requests live on the Requests tab —
 * this page used to carry them too, and a client looking for "is anyone
 * visiting" had to scroll past a progress track to find out. What stays is
 * one clear way in: a "Make a request" button, which also says when a change
 * is waiting for them to look at, since that is the one thing on the portal
 * where nothing happens until they act.
 *
 * The visitor figures stream. Everything above them needs only the portal's
 * own database, and answers in tens of milliseconds; the figures need up to
 * eight calls to the analytics service, which on a cold cache is the slowest
 * thing the portal does. Rendering the page as one unit meant the whole thing
 * waited for the slowest part. With the analytics inside `<Suspense>`, the
 * shell, the banner and the request list are on screen while the numbers are
 * still on their way — and a skeleton the same shape as the panel holds the
 * space so nothing jumps when they land.
 *
 * Every query goes through a `TenantContext` built from the session's own
 * organization. There is no code path here that could read another client's
 * data, and nothing on this page can reach the Potential Clients area.
 */
export default async function ClientDashboard({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role === "admin") redirect("/admin");

  const params = await searchParams;
  /*
   * Filters come from the URL, and the URL cannot name a site.
   *
   * `parseFilters` has no `websiteId` field by construction — the site is
   * resolved from the session below. That is the guarantee that stops a client
   * from reaching another client's figures by editing a query string.
   */
  const filters = parseFilters(params);
  const days: RangeDays = isValidRange(filters.range) ? filters.range : 30;

  if (!user.organizationId) {
    return (
      <>
        <main className="shell">
          <div className="masthead">
            <h1>Your website</h1>
          </div>
          <p className="notice">
            Your account is not yet linked to an organization. Please contact us
            and we will finish setting it up.
          </p>
        </main>
      </>
    );
  }

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();

  // The same query the Requests page uses to build its panel — one source,
  // so this page and that one cannot disagree about what is waiting.
  const awaitingApproval = await listPreviewsAwaitingDecision(db, ctx);

  // Analytics is kicked off here, before any HTML is sent, and awaited inside
  // the boundary below. Starting it early means the eight analytics calls run
  // *while* the top of the page is being streamed, not after.
  // Filters, not just the day count: the provider query narrows too, so the
  // breakdowns and the headline figures agree with each other.
  const analytics = resolveClientAnalytics(db, ctx, filters);

  return (
    <>
      <main className="shell">
        <div className="masthead">
          <h1>Your website</h1>
          <Suspense fallback={null}>
            <SiteLink analytics={analytics} />
          </Suspense>
        </div>

        <MakeARequest waiting={awaitingApproval.map((p) => p.requestTitle)} />

        <Suspense fallback={<VisitorsSkeleton />}>
          <VisitorPanels analytics={analytics} days={days} filters={filters} />
        </Suspense>
      </main>
    </>
  );
}

type Analytics = ReturnType<typeof resolveClientAnalytics>;

async function SiteLink({ analytics }: { analytics: Analytics }) {
  const { site } = await analytics;
  if (!site) return null;
  return (
    <span className="muted">
      {site.primaryDomain ? (
        <a
          href={`https://${site.primaryDomain}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {site.primaryDomain}
        </a>
      ) : (
        site.name
      )}
    </span>
  );
}

/** "google.com 31% · mobile 61% · United States 88%" — the top of each list. */
function teaser(lists: { rows: Breakdown[]; suffix?: string }[]): string {
  return lists
    .map(({ rows, suffix }) => {
      const total = rows.reduce((s, r) => s + r.value, 0);
      const top = rows[0];
      if (!top || total === 0) return null;
      const share = Math.round((top.value / total) * 100);
      return `${top.label} ${share}%${suffix ?? ""}`;
    })
    .filter(Boolean)
    .join(" · ");
}

async function VisitorPanels({
  analytics,
  days,
  filters,
}: {
  analytics: Analytics;
  days: RangeDays;
  /** Passed down rather than re-parsed, so one request has one filter set. */
  filters: AnalyticsFilters;
}) {
  const { state, data, showingDemo, isDemoSite } = await analytics;

  // What the change arrows are measured against, spelled out for anyone
  // listening to the page rather than looking at it.
  const comparedTo = `previous ${days} days`;
  const updatedAt = formatTime(data.generatedAt);

  /*
   * The same miscount as the old event panel, in a second place.
   *
   * "Everything that is not a photo is contact" counted portfolio tiles, CTAs
   * and shop links as people getting in touch, and put the total in the panel
   * summary where it is read first and questioned least. It now comes from the
   * registry, and it says "reached out" — taps on a phone number or an email
   * address — rather than claiming anyone made contact.
   */
  const contactTaps = categoriseEvents(data.events)
    .filter((group) => group.category === "contact_intent")
    .reduce((sum, group) => sum + group.total, 0);

  return (
    <>
      {showingDemo && <DemoBanner state={state} />}
      {isDemoSite && !showingDemo && (
        <p className="notice">
          <span className="badge">Demo</span> This is a seeded demo site.
        </p>
      )}

      {/* ---------------------------------------------- headline figures */}
      <section className="panel">
        <div className="panel-head">
          <h2>
            Your visitors{" "}
            <span className="panel-sub">· updated {updatedAt}</span>
          </h2>
          <nav className="segmented" aria-label="Time range">
            {(Object.keys(RANGES) as unknown as RangeDays[]).map((value) => (
              <Link
                key={value}
                href={`/dashboard${serialiseFilters({ ...filters, range: Number(value) as RangeDays })}`}
                aria-current={Number(value) === days ? "true" : undefined}
              >
                {RANGES[value].replace("Last ", "")}
              </Link>
            ))}
          </nav>
        </div>

        <AnalyticsFilterBar
          filters={filters}
          basePath="/dashboard"
          devices={data.devices.map((d) => d.label)}
          referrers={data.referrers.map((r) => r.label)}
          pages={data.topPages.map((p) => p.label)}
        />

        <StatRow data={data} comparedTo={comparedTo} />

        {/* Said once, near the figures it qualifies. Every trailing window ends
            mid-day, so a client comparing this morning with yesterday is
            comparing a part-day against a whole one. */}
        <p className="field-hint">
          Today is still in progress, so the most recent day is partial.
        </p>

        {data.anomaly && (
          <p className="notice">
            These figures do not add up as expected ({data.anomaly}) — we are
            looking into it. Treat them as indicative for now.
          </p>
        )}

        <div className="panel-body">
          <TimeSeriesChart series={data.series} metric="visits" />
          <TimeSeriesChart
            series={data.series}
            metric="pageviews"
            gradientId="chart-area-fade-pageviews"
          />
          <SeriesTable series={data.series} />
        </div>
      </section>

      {/* ------------------------------------------------- the audience */}
      {/* Folded, with the answer in the summary line. The headline of each
          breakdown — top referrer, top device, top country — is what most
          clients want; the full lists are one tap away. On a phone this
          halves the page; on a desktop it reads as a summary row. */}
      <details className="panel panel-fold">
        <summary className="panel-head">
          <h2>Where your visitors came from</h2>
          <span className="panel-sub">
            {teaser([
              { rows: data.referrers },
              { rows: data.devices },
              { rows: data.countries },
            ]) || RANGES[days]}
          </span>
        </summary>

        <div className="panel-split panel-split-3">
          <div>
            <h3>How they found you</h3>
            <BarList rows={data.referrers} unit="visitors" />
            <p className="panel-note">
              &ldquo;Direct&rdquo; means they typed the address or used a
              bookmark — often someone you gave a card to.
            </p>
          </div>
          <div>
            <h3>What they used</h3>
            <BarList rows={data.devices} unit="visitors" />
          </div>
          <div>
            <h3>Where they were</h3>
            <BarList rows={data.countries} unit="visitors" />
          </div>
        </div>
      </details>

      {/* --------------------------------------------- what they did */}
      <details className="panel panel-fold">
        <summary className="panel-head">
          <h2>What they looked at</h2>
          <span className="panel-sub">
            {[
              teaser([{ rows: data.topPages, suffix: " of views" }]),
              contactTaps > 0
                ? `${contactTaps} ${contactTaps === 1 ? "tap" : "taps"} on a phone number or email`
                : null,
            ]
              .filter(Boolean)
              .join(" · ") || RANGES[days]}
          </span>
        </summary>

        <div className="panel-split panel-split-2">
          <div>
            <h3>Most viewed pages</h3>
            <BarList rows={data.topPages} unit="views" />
          </div>
          <EventPanels
            events={data.events}
            categoryFilter={filters.eventCategory}
            // A site that has never emitted an event has not been tagged; one
            // that has, and shows none this period, was simply quiet.
            trackingConfigured={data.events.length > 0}
          />
        </div>
      </details>
    </>
  );
}

/**
 * The way into Requests, and the one request-shaped thing this page says.
 *
 * Always the same button, so a client learns where it is. When a change is
 * waiting for them, the pane says so and offers to take them to it — a
 * preview nobody looks at is a change that never goes live.
 */
function MakeARequest({ waiting }: { waiting: string[] }) {
  const ready = waiting.length > 0;

  return (
    <section className="card request-cta">
      <div className="request-cta-copy">
        <h2>Want something changed?</h2>
        <p className="muted">
          Tell us what you&rsquo;d like and we&rsquo;ll make it on a preview
          first. Nothing changes on your site until you&rsquo;ve seen it and
          said yes.
        </p>
        {ready && (
          <p className="request-cta-ready">
            {waiting.length === 1
              ? <>Your change &ldquo;{waiting[0]}&rdquo; is ready to look at.</>
              : <>{waiting.length} changes are ready to look at.</>}
          </p>
        )}
      </div>
      <div className="request-cta-actions">
        <Link className="button" href="/dashboard/requests">
          Make a request
        </Link>
        {ready && (
          <Link className="button secondary" href="/dashboard/requests#awaiting-approval">
            Look at {waiting.length === 1 ? "it" : "them"}
          </Link>
        )}
      </div>
    </section>
  );
}
