import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { SitePreview, siteHomeUrl } from "@/components/site-preview";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import { listClients } from "@/db/repositories/admin/clients";
import { listSitesWithAnalytics } from "@/db/repositories/admin/sites";
import { StatRow } from "@/components/analytics-summary";
import { TimeSeriesChart } from "@/components/charts";
import { demoAnalytics } from "@/lib/analytics/demo";
import { demoReason } from "@/lib/analytics/resolve";
import {
  fetchAnalytics,
  isUmamiConfigured,
  type AnalyticsState,
  type AnalyticsSummary,
} from "@/lib/analytics/umami";

export const dynamic = "force-dynamic";

const SITE_STATUS_PILL: Record<string, string> = {
  draft: "pill-neutral",
  preview: "pill-warning",
  live: "pill-success",
  archived: "pill-neutral",
};

const SITE_STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  preview: "Demo",
  live: "Live",
  archived: "Archived",
};

/**
 * The client list, and the way into every per-client action.
 *
 * Gated twice like every admin surface: the page check below, and
 * `adminContextFrom`, which refuses a session that is not an active admin.
 */
export default async function AdminClientsPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role !== "admin") redirect("/dashboard");

  const ctx = adminContextFrom(user);
  const db = await getDb();
  const clients = await listClients(ctx, db);
  const umamiReady = isUmamiConfigured();

  // One site (the oldest, same convention as the client-detail page) and its
  // analytics per client, fetched here rather than lazily on expand — these
  // are server components with no client-side data fetching wired up, so the
  // collapsible only hides markup that already rendered, not a page-weight
  // saving. Sample data with an honest label stands in before a Umami website
  // ID is set, same as everywhere else analytics shows up.
  const withSites = await Promise.all(
    clients.map(async (c) => {
      const sites = await listSitesWithAnalytics(ctx, db, c.organizationId);
      const site = sites[0] ?? null;
      if (!site) return { client: c, site: null, analytics: null };

      const state: AnalyticsState = site.umamiWebsiteId
        ? await fetchAnalytics(site.umamiWebsiteId, 30)
        : umamiReady
          ? { kind: "not_connected" }
          : { kind: "not_configured" };
      const data: AnalyticsSummary =
        state.kind === "ok" ? state.data : demoAnalytics(site.publicId, 30);

      return { client: c, site, analytics: { state, data } };
    }),
  );

  return (
    <>
      <main className="shell">
        <div className="masthead">
          <h1>Clients</h1>
          <div className="actions">
            <span className="muted" style={{ alignSelf: "center" }}>
              {clients.length} {clients.length === 1 ? "client" : "clients"}
            </span>
            <Link className="button" href="/admin/clients/new">
              Add a client
            </Link>
          </div>
        </div>

        {clients.length === 0 ? (
          <section className="card">
            <div className="empty">
              <p className="empty-title">No clients yet.</p>
              <p>
                Add one to create their record. Issuing their portal
                credentials is a separate step on their own page.
              </p>
              <p style={{ marginTop: "1rem" }}>
                <Link className="button" href="/admin/clients/new">
                  Add a client
                </Link>
              </p>
            </div>
          </section>
        ) : (
          <div className="client-tile-grid">
            {withSites.map(({ client: c, site, analytics }) => (
              <details key={c.clientPublicId} className="client-tile">
                <summary>
                  <div className="client-tile-media">
                    <SitePreview
                      url={site ? siteHomeUrl(site) : null}
                      name={site?.name ?? c.name}
                      mode={site?.previewMode}
                      fallbackInitial={(site?.name ?? c.name).charAt(0).toUpperCase()}
                    />
                    <span className="client-tile-chevron" aria-hidden="true" />
                  </div>
                  <div className="client-tile-body">
                    <div className="client-tile-eyebrow">
                      <span>{c.industry ?? "Client"}</span>
                      <span
                        className={`pill ${site ? SITE_STATUS_PILL[site.status] : "pill-neutral"}`}
                      >
                        {site ? SITE_STATUS_LABEL[site.status] : "No site"}
                      </span>
                    </div>
                    <p className="client-tile-title">
                      {site?.name ?? c.name}
                    </p>
                    <p className="client-tile-meta">
                      {c.name}
                      {c.isDemo && (
                        <>
                          {" "}
                          <span className="badge">demo</span>
                        </>
                      )}
                    </p>
                  </div>
                </summary>

                <div className="client-tile-analytics">
                  {!site ? (
                    <p className="muted" style={{ margin: 0 }}>
                      No site recorded yet, so there is nothing to show
                      analytics for.
                    </p>
                  ) : (
                    <>
                      {demoReason(analytics!.state) && (
                        <p className="notice" style={{ marginBottom: "1rem" }}>
                          <span className="badge">Sample data</span>{" "}
                          {demoReason(analytics!.state)}
                        </p>
                      )}
                      <StatRow
                        data={analytics!.data}
                        comparedTo="previous 30 days"
                      />
                      <div style={{ marginTop: "1rem" }}>
                        <TimeSeriesChart series={analytics!.data.series} />
                      </div>
                    </>
                  )}

                  <div className="client-tile-actions">
                    <Link
                      href={`/admin/clients/${c.clientPublicId}`}
                      className="linklike"
                    >
                      View full client page →
                    </Link>
                  </div>
                </div>
              </details>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
