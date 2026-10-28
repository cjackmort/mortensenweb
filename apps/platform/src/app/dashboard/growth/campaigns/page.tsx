import Link from "next/link";
import { BackToGrowth } from "@/components/back-link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { BarList, Sparkline } from "@/components/charts";
import { Stat } from "@/components/analytics-summary";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { requireGrowthFeature } from "@/db/repositories/client/growth";
import { campaignAnalyticsTargets, listCampaigns, type CampaignListItem } from "@/db/repositories/client/campaigns";
import { campaignStats, type ScanStats } from "@/db/repositories/client/campaign-stats";
import { attributeCampaigns, type AttributionState } from "@/lib/campaigns/attribution";
import { formatDateWithYear } from "@/lib/time";
import { ScanChart } from "./campaign-visuals";

/**
 * QR & campaign tracking: which print brought people to the website.
 *
 * Two sources, kept visibly apart. Scans are counted by the portal itself,
 * at the short link. Visits and taps come from the site's own analytics,
 * filtered by the campaign's `utm_campaign`, and appear only when that
 * analytics is connected and answering — otherwise the page says which of
 * those it is, and draws no column of zeroes.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Campaigns",
  robots: { index: false, follow: false },
};

const DAYS = 30;

export default async function CampaignsPage() {
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
  if (!(await requireGrowthFeature(db, ctx, "campaigns"))) redirect("/dashboard/growth?locked=campaigns#campaigns");

  const now = new Date();
  const [list, stats, targets] = await Promise.all([
    listCampaigns(db, ctx, { days: DAYS, now }),
    campaignStats(db, ctx, { days: DAYS, now }),
    campaignAnalyticsTargets(db, ctx),
  ]);
  const ranked = [...list].sort((a, b) => b.scansInWindow - a.scansInWindow || b.scansTotal - a.scansTotal);
  const attribution = await attributeCampaigns(
    ranked.filter((c) => c.scansTotal > 0).map((c) => targets.get(c.publicId)!).filter(Boolean),
    { startAt: now.getTime() - DAYS * 24 * 60 * 60 * 1000, endAt: now.getTime() },
  );

  return (
    <main className="shell">
      <BackToGrowth />
      <div className="masthead">
        <h1>Campaigns</h1>
        <span>QR codes and short links for your print</span>
      </div>

      <p>
        <Link className="button" href="/dashboard/growth/campaigns/new">
          New campaign
        </Link>
      </p>

      {list.length === 0 ? (
        <section className="panel">
          <div className="empty">
            <p className="empty-title">No campaigns yet</p>
            <p>
              Make one for each thing you print — this spring&rsquo;s door hangers, the yard signs, the van. Each gets
              its own QR code, so you can see which one brings people to your website.
            </p>
          </div>
        </section>
      ) : (
        <>
          <ScansPanel stats={stats} list={list} />
          <CampaignTable campaigns={ranked} attribution={attribution} />
          {stats.hasScansInWindow && (
            <section className="panel">
              <div className="panel-head">
                <h2>Who scanned</h2>
                <span className="panel-sub">Last {DAYS} days</span>
              </div>
              <div className="panel-split panel-split-2">
                <div>
                  <h3>What they scanned with</h3>
                  <BarList rows={stats.byDevice} unit="scans" />
                </div>
                <div>
                  <h3>Where they were</h3>
                  <BarList rows={stats.byTown} unit="scans" />
                  <p className="panel-note">
                    From the scanning phone&rsquo;s internet connection, so it is the nearest town, not an address.
                  </p>
                </div>
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}

function ScansPanel({ stats, list }: { stats: ScanStats; list: CampaignListItem[] }) {
  const last = list.reduce<Date | null>(
    (latest, c) => (c.lastScanAt && (!latest || c.lastScanAt > latest) ? c.lastScanAt : latest),
    null,
  );
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Scans</h2>
        <span className="panel-sub">Last {DAYS} days</span>
      </div>
      {stats.allTime === 0 ? (
        <div className="empty">
          <p className="empty-title">No scans yet</p>
          <p>
            Each scan of a code, or visit to its short link, shows up here within seconds. Print a code and try it
            with your own phone.
          </p>
        </div>
      ) : !stats.hasScansInWindow ? (
        <div className="empty">
          <p>
            No scans in the last {DAYS} days.{last ? ` The last one was on ${formatDateWithYear(last)}.` : ""}
          </p>
        </div>
      ) : (
        <>
          <div className="metrics campaign-metrics">
            <Stat label="Scans" value={stats.total.toLocaleString("en-US")} note={`In the last ${DAYS} days`} />
            <Stat label="All time" value={stats.allTime.toLocaleString("en-US")} note="Since your first campaign" />
            <Stat
              label="Top campaign"
              value={stats.byCampaign[0]?.name ?? "—"}
              note={`${stats.byCampaign[0]?.scans ?? 0} scans in the last ${DAYS} days`}
            />
          </div>
          <div className="panel-body">
            <ScanChart series={stats.series} label="Scans per day, all campaigns" />
          </div>
        </>
      )}
    </section>
  );
}

function attributionNote(state: AttributionState): string | null {
  switch (state.kind) {
    case "ok":
      return "Visits and taps come from your website's analytics, for people who arrived through each code's link. Taps count presses on your phone number, email or booking link on the page the code opened — not calls made.";
    case "not_configured":
    case "not_connected":
      return "Visits from each campaign appear here once your website's analytics is connected. Scans are counted either way.";
    case "error":
      return `We could not reach your website's analytics just now (${state.message}), so visits are not shown. Scans above are unaffected.`;
  }
}

function CampaignTable({
  campaigns,
  attribution,
}: {
  campaigns: CampaignListItem[];
  attribution: AttributionState;
}) {
  const showVisits = attribution.kind === "ok";
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Your campaigns</h2>
        <span className="panel-sub">Most scanned first</span>
      </div>
      <div className="panel-body">
        <div className="table-wrap">
          <table className="stack campaign-table">
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Scans, {DAYS} days</th>
                <th>All time</th>
                {showVisits && <th>Visits</th>}
                {showVisits && <th>Taps to get in touch</th>}
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => {
                const figures = attribution.kind === "ok" ? attribution.byUtm[c.utmCampaign] : undefined;
                return (
                  <tr key={c.publicId}>
                    <td data-label="Campaign">
                      <Link href={`/dashboard/growth/campaigns/${c.publicId}`} className="campaign-name">
                        {c.name}
                      </Link>
                      <span className="campaign-meta">
                        {c.placementLabel} · {c.printedLink}
                        {c.paused && <span className="pill pill-neutral">Paused</span>}
                      </span>
                    </td>
                    <td data-label={`Scans, ${DAYS} days`}>
                      <span className="campaign-count">
                        {c.scansInWindow.toLocaleString("en-US")}
                        {c.scansInWindow > 0 && <Sparkline values={c.daily} id={`spark-${c.publicId}`} />}
                      </span>
                    </td>
                    <td data-label="All time">{c.scansTotal.toLocaleString("en-US")}</td>
                    {showVisits && (
                      <td data-label="Visits">{figures ? figures.visitors.toLocaleString("en-US") : "—"}</td>
                    )}
                    {showVisits && (
                      <td data-label="Taps to get in touch">
                        {figures ? figures.reachedOut.toLocaleString("en-US") : "—"}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="panel-note">{attributionNote(attribution)}</p>
      </div>
    </section>
  );
}
