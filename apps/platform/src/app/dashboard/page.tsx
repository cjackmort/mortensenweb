import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { DemoBanner, StatRow } from "@/components/analytics-summary";
import { BarList, SeriesTable, TimeSeriesChart } from "@/components/charts";
import { RequestProgress } from "@/components/request-progress";
import { ClickSummary } from "@/components/click-summary";
import { VisitorsSkeleton } from "@/components/skeletons";
import { CancelRequestButton } from "./requests/cancel-button";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { listChangeRequests } from "@/db/repositories/client/change-requests";
import { listPreviewsAwaitingDecision } from "@/db/repositories/client/previews";
import { resolveClientAnalytics } from "@/lib/analytics/resolve";
import {
  RANGES,
  isValidRange,
  type Breakdown,
  type RangeDays,
} from "@/lib/analytics/umami";
import { formatDate, formatTime } from "@/lib/time";
import { isCancellable, openCount, stageIndex } from "@/lib/requests/status";

export const dynamic = "force-dynamic";

/**
 * Client dashboard.
 *
 * Two things a client opens this for, in order: **is anything waiting on me**,
 * and **is anyone looking at my site**. The page is laid out in that order.
 * A preview needing approval sits directly under the title; an in-progress
 * request comes next, because it is the one thing on the page they can act
 * on; the visitor figures follow.
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
  searchParams: Promise<{ range?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role === "admin") redirect("/admin");

  const params = await searchParams;
  const parsed = Number(params.range);
  const days: RangeDays = isValidRange(parsed) ? parsed : 30;

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

  const [requests, awaitingApproval] = await Promise.all([
    listChangeRequests(db, ctx, { limit: 5 }),
    // The same query the Requests page uses to build its panel — one source,
    // so the banner and the panel cannot disagree about what is waiting.
    listPreviewsAwaitingDecision(db, ctx),
  ]);

  const openRequests = openCount(requests);

  // Analytics is kicked off here, before any HTML is sent, and awaited inside
  // the boundary below. Starting it early means the eight analytics calls run
  // *while* the top of the page is being streamed, not after.
  const analytics = resolveClientAnalytics(db, ctx, days);

  const requestsPanel = (
    <RecentRequests
      requests={requests}
      openRequests={openRequests}
    />
  );

  return (
    <>
      <main className="shell">
        <div className="masthead">
          <h1>Your website</h1>
          <Suspense fallback={null}>
            <SiteLink analytics={analytics} />
          </Suspense>
        </div>

        {/* Directly under the title. A preview waiting on the client is the
            only thing on this page where nothing happens until they act. It
            links to the approval panel, not to the preview itself: opening
            the preview from here would show them the change with no way to
            say yes to it. */}
        {awaitingApproval.length > 0 && (
          <div className="notice notice-action">
            <strong>
              {awaitingApproval.length === 1
                ? "Your change is ready to look at."
                : `${awaitingApproval.length} changes are ready to look at.`}
            </strong>{" "}
            {awaitingApproval.length === 1 && awaitingApproval[0] && (
              <span className="muted">{awaitingApproval[0].requestTitle}</span>
            )}
            <p style={{ margin: "0.5rem 0 0" }}>
              Nothing changes on your site until you approve it.
            </p>
            <p style={{ margin: "0.75rem 0 0" }}>
              <Link className="button" href="/dashboard/requests#awaiting-approval">
                Review it now
              </Link>
            </p>
          </div>
        )}

        {/* Something in progress goes above the figures. On a phone the old
            order put it sixteen screens down, under four panels of numbers
            the client could only look at. */}
        {openRequests > 0 && requestsPanel}

        <Suspense fallback={<VisitorsSkeleton />}>
          <VisitorPanels analytics={analytics} days={days} />
        </Suspense>

        {openRequests === 0 && requestsPanel}
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
}: {
  analytics: Analytics;
  days: RangeDays;
}) {
  const { state, data, showingDemo, isDemoSite } = await analytics;

  // What the change arrows are measured against, spelled out for anyone
  // listening to the page rather than looking at it.
  const comparedTo = `previous ${days} days`;
  const updatedAt = formatTime(data.generatedAt);

  const contactCount = data.events
    .filter((e) => !e.label.toLowerCase().startsWith("photo:"))
    .reduce((s, e) => s + e.value, 0);

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
                href={`/dashboard?range=${value}`}
                aria-current={Number(value) === days ? "true" : undefined}
              >
                {RANGES[value].replace("Last ", "")}
              </Link>
            ))}
          </nav>
        </div>

        <StatRow data={data} comparedTo={comparedTo} />

        <div className="panel-body">
          <TimeSeriesChart series={data.series} />
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
              contactCount > 0
                ? `${contactCount} got in touch`
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
          <ClickSummary events={data.events} />
        </div>
      </details>
    </>
  );
}

function RecentRequests({
  requests,
  openRequests,
}: {
  requests: Awaited<ReturnType<typeof listChangeRequests>>;
  openRequests: number;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{openRequests > 0 ? "In progress" : "Recent requests"}</h2>
        <span className="panel-head-actions">
          <Link href="/dashboard/requests">
            {requests.length === 0 ? "Request a change" : "All requests"}
          </Link>
        </span>
      </div>

      <div className="panel-body">
        {requests.length === 0 ? (
          <div className="empty">
            <p className="empty-title">No requests yet.</p>
            <p>
              Anything you&rsquo;d like changed on your site — send it over and
              we&rsquo;ll pick it up.
            </p>
            <p style={{ marginTop: "1rem" }}>
              <Link className="button" href="/dashboard/requests">
                Request a change
              </Link>
            </p>
          </div>
        ) : (
          <>
            {requests.map((r) => (
              <div key={r.publicId} className="request-item">
                <div className="request-head">
                  <p className="request-title">{r.title}</p>
                  <span className="muted" style={{ fontSize: "0.8rem" }}>
                    sent {formatDate(r.createdAt)}
                  </span>
                </div>
                <RequestProgress status={r.status} stage={stageIndex(r.status)} />

                {/* Also here, not only on Requests. A cancel control the
                    client cannot find is one that does not exist — the
                    request stays open and the one-per-site rule then blocks
                    them from raising anything else. */}
                {isCancellable(r.status) && (
                  <CancelRequestButton
                    requestPublicId={r.publicId}
                    hasPreview={Boolean(r.previewUrl)}
                  />
                )}
              </div>
            ))}
            {openRequests > 0 && (
              <p
                className="muted"
                style={{ margin: "1rem 0 0", fontSize: "0.85rem" }}
              >
                {openRequests} still in progress.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
