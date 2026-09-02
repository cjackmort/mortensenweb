import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { AppShell } from "@/components/app-shell";
import { DemoBanner, StatRow } from "@/components/analytics-summary";
import { BarList, SeriesTable, TimeSeriesChart } from "@/components/charts";
import { RequestProgress } from "@/components/request-progress";
import { ClickSummary } from "@/components/click-summary";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import { getClientDetail, getInternalClient } from "@/db/repositories/admin/clients";
import { listSitesWithAnalytics } from "@/db/repositories/admin/sites";
import {
  fetchAnalytics,
  isUmamiConfigured,
  RANGES,
  isValidRange,
  type RangeDays,
} from "@/lib/analytics/umami";
import { demoAnalytics } from "@/lib/analytics/demo";
import { demoReason } from "@/lib/analytics/resolve";
import { isCancellable, statusLabel, stageIndex } from "@/lib/requests/status";
import { InternalCancelButton, InternalRequestForm } from "./internal-request-form";

export const dynamic = "force-dynamic";

/**
 * The agency's own site, viewed the same way a client sees theirs.
 *
 * Deliberately not the operator's brief-writing tool (that stays on the
 * client-detail page, for calls with actual clients) — this is the visitor
 * figures and the request form a client gets, so testing a change on the
 * agency's own site means using the exact thing being tested. Submitting and
 * cancelling go through `internal-requests.ts`, an admin-safe parallel to the
 * client repository: there is no client session to build a `TenantContext`
 * from here, by design, so this cannot become a general "act as any client"
 * tool — it only ever touches the one organization `getInternalClient` finds.
 */
export default async function MortensenWebPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role !== "admin") redirect("/dashboard");

  const params = await searchParams;
  const parsed = Number(params.range);
  const days: RangeDays = isValidRange(parsed) ? parsed : 30;

  const ctx = adminContextFrom(user);
  const db = await getDb();

  const internal = await getInternalClient(ctx, db);
  if (!internal) {
    return (
      <AppShell user={user}>
        <main className="shell">
          <div className="masthead">
            <h1>MortensenWeb</h1>
          </div>
          <section className="card">
            <div className="empty">
              <p className="empty-title">Not linked yet.</p>
              <p>
                Run <code>npx tsx scripts/link-internal-site.ts</code> to
                attach the agency&rsquo;s own site to this pipeline.
              </p>
            </div>
          </section>
        </main>
      </AppShell>
    );
  }

  const detail = await getClientDetail(ctx, db, internal.clientPublicId);
  const [siteRows] = await Promise.all([
    listSitesWithAnalytics(ctx, db, internal.organizationId),
  ]);
  const site = siteRows[0] ?? null;
  const { requests } = detail;

  const umamiReady = isUmamiConfigured();
  const state = site?.umamiWebsiteId
    ? await fetchAnalytics(site.umamiWebsiteId, days)
    : umamiReady
      ? { kind: "not_connected" as const }
      : { kind: "not_configured" as const };
  const data = state.kind === "ok" ? state.data : demoAnalytics(site?.publicId ?? "mortensenweb", days);
  const reason = demoReason(state);

  const updatedAt = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  const comparedTo = `previous ${days} days`;

  return (
    <AppShell user={user}>
      <main className="shell">
        <div className="masthead">
          <h1>MortensenWeb</h1>
          <span className="muted">
            <Link href={`/admin/clients/${internal.clientPublicId}`}>
              Full client record →
            </Link>
          </span>
        </div>

        {reason && <DemoBanner state={state} />}

        {!site && (
          <p className="notice">No site recorded for the agency yet.</p>
        )}

        {site && (
          <>
            <section className="panel">
              <div className="panel-head">
                <h2>
                  Your visitors <span className="panel-sub">· updated {updatedAt}</span>
                </h2>
                <nav className="segmented" aria-label="Time range">
                  {(Object.keys(RANGES) as unknown as RangeDays[]).map((value) => (
                    <Link
                      key={value}
                      href={`/admin/mortensenweb?range=${value}`}
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

            <section className="panel">
              <div className="panel-head">
                <h2>Where your visitors came from</h2>
                <span className="panel-sub">{RANGES[days]}</span>
              </div>

              <div className="panel-split panel-split-3">
                <div>
                  <h3>How they found you</h3>
                  <BarList rows={data.referrers} unit="visitors" />
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
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2>What they looked at</h2>
                <span className="panel-sub">{RANGES[days]}</span>
              </div>

              <div className="panel-split panel-split-2">
                <div>
                  <h3>Most viewed pages</h3>
                  <BarList rows={data.topPages} unit="views" />
                </div>
                <ClickSummary events={data.events} />
              </div>
            </section>
          </>
        )}

        <section className="card">
          <div className="card-head">
            <h2>Request a change</h2>
          </div>
          <p className="muted" style={{ marginTop: 0 }}>
            The same request a client submits, going through the same
            pipeline against <code>cjackmort/mortensenweb</code> — a real way
            to test a change before deciding whether a client should see it
            offered.
          </p>
          {site ? (
            <InternalRequestForm sitePublicId={site.publicId} />
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              No site to attach a request to yet.
            </p>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Requests</h2>
            <span className="muted">{requests.length}</span>
          </div>

          {requests.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              No requests yet.
            </p>
          ) : (
            requests.map((r) => (
              <div key={r.publicId} className="request-item">
                <div className="request-head">
                  <p className="request-title">{r.title}</p>
                  <span className="muted" style={{ fontSize: "0.8rem" }}>
                    sent{" "}
                    {r.createdAt.toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                </div>
                <RequestProgress status={r.status} stage={stageIndex(r.status)} />
                {isCancellable(r.status) && (
                  <div style={{ marginTop: "0.5rem" }}>
                    <InternalCancelButton requestPublicId={r.publicId} />
                  </div>
                )}
                {!isCancellable(r.status) && (
                  <span className="muted" style={{ fontSize: "0.8rem" }}>
                    {statusLabel(r.status)}
                  </span>
                )}
              </div>
            ))
          )}
        </section>
      </main>
    </AppShell>
  );
}
