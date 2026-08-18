import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { AppShell } from "@/components/app-shell";
import { DemoBanner, StatRow } from "@/components/analytics-summary";
import { BarList, SeriesTable, TimeSeriesChart } from "@/components/charts";
import { RequestProgress } from "@/components/request-progress";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { listChangeRequests } from "@/db/repositories/client/change-requests";
import { resolveClientAnalytics } from "@/lib/analytics/resolve";
import { RANGES, isValidRange, type RangeDays } from "@/lib/analytics/umami";
import { openCount, stageIndex } from "@/lib/requests/status";

export const dynamic = "force-dynamic";

/**
 * Client dashboard.
 *
 * Visitor figures lead, because that is what a client opens this for — "is
 * anyone looking at my site" is the question, and making them find a tab to
 * answer it is the wrong default. The full breakdowns stay on the Visitors
 * page; this is the headline and the shape of the last 30 days.
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
      <AppShell user={user}>
        <main className="shell">
          <div className="masthead">
            <h1>Your website</h1>
          </div>
          <p className="notice">
            Your account is not yet linked to an organization. Please contact us
            and we will finish setting it up.
          </p>
        </main>
      </AppShell>
    );
  }

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();

  // Analytics is fetched alongside the rest rather than after it: the Umami
  // call is cached for five minutes, so this costs nothing on a warm cache and
  // one round trip on a cold one.
  const [analytics, requests] = await Promise.all([
    resolveClientAnalytics(db, ctx, days),
    listChangeRequests(db, ctx, { limit: 5 }),
  ]);

  const { site, state, data, showingDemo, isDemoSite } = analytics;
  const openRequests = openCount(requests);

  // Anything the client is holding up. `previewUrl` is already gated on the
  // preview having been fetched and answered, so a request only reaches this
  // banner once there is something real to look at; `pending` excludes the ones
  // they have already decided on.
  const awaitingApproval = requests.filter(
    (r) => r.previewUrl && r.previewDecision === "pending",
  );

  return (
    <AppShell user={user}>
      <main className="shell">
        <div className="masthead">
          <h1>Your website</h1>
          {site && (
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
          )}
        </div>

        {/* Directly under the title, above the visitor figures. A preview
            waiting on the client is the only thing on this page where nothing
            happens until they act, and the previous version left it findable
            only by going to Requests and scrolling — so previews sat unapproved
            for days. It links straight to the approval panel, not to the
            preview itself: opening the preview from here would show them the
            change with no way to say yes to it. */}
        {awaitingApproval.length > 0 && (
          <div className="notice notice-action">
            <strong>
              {awaitingApproval.length === 1
                ? "Your change is ready to look at."
                : `${awaitingApproval.length} changes are ready to look at.`}
            </strong>{" "}
            {awaitingApproval.length === 1 && awaitingApproval[0] && (
              <span className="muted">{awaitingApproval[0].title}</span>
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

        {showingDemo && <DemoBanner state={state} />}
        {isDemoSite && !showingDemo && (
          <p className="notice">
            <span className="badge">Demo</span> This is a seeded demo site.
          </p>
        )}

        <nav className="rangebar" aria-label="Time range">
          {(Object.keys(RANGES) as unknown as RangeDays[]).map((value) => (
            <Link
              key={value}
              href={`/dashboard?range=${value}`}
              aria-current={Number(value) === days ? "true" : undefined}
            >
              {RANGES[value]}
            </Link>
          ))}
        </nav>

        <StatRow data={data} />

        <section className="card">
          <div className="card-head">
            <h2>Visitors over time</h2>
            <span className="muted">{RANGES[days]}</span>
          </div>
          <TimeSeriesChart series={data.series} />
          <SeriesTable series={data.series} />
        </section>

        <div className="grid grid-2">
          <section className="card">
            <h2>Most viewed pages</h2>
            <BarList rows={data.topPages} unit="views" />
          </section>

          <section className="card">
            <h2>How they found you</h2>
            <BarList rows={data.referrers} unit="visitors" />
            <p className="muted" style={{ fontSize: "0.8rem", margin: "0.75rem 0 0" }}>
              &ldquo;Direct&rdquo; means they typed the address or used a
              bookmark — often someone you gave a card to.
            </p>
          </section>

          <section className="card">
            <h2>What they used</h2>
            <BarList rows={data.devices} unit="visitors" />
          </section>

          <section className="card">
            <h2>Where they were</h2>
            <BarList rows={data.countries} unit="visitors" />
          </section>
        </div>

        <section className="card">
          <div className="card-head">
            <h2>Recent requests</h2>
            <Link href="/dashboard/requests">
              {requests.length === 0 ? "Request a change" : "All requests"}
            </Link>
          </div>

          {requests.length === 0 ? (
            <div className="empty">
              <p className="empty-title">No requests yet.</p>
              <p>
                Anything you&rsquo;d like changed on your site — send it over
                and we&rsquo;ll pick it up.
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
                      sent{" "}
                      {new Date(r.createdAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        timeZone: "America/Denver",
                      })}
                    </span>
                  </div>
                  <RequestProgress
                    status={r.status}
                    stage={stageIndex(r.status)}
                  />
                </div>
              ))}
              {openRequests > 0 && (
                <p className="muted" style={{ margin: "1rem 0 0", fontSize: "0.85rem" }}>
                  {openRequests} still in progress.
                </p>
              )}
            </>
          )}
        </section>
      </main>
    </AppShell>
  );
}
