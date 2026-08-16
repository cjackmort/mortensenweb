import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { AppShell } from "@/components/app-shell";
import { getDb } from "@/db/client";
import { adminContextFrom, NotFoundError } from "@/db/repositories/context";
import {
  getClientDetail,
  listOrganizationUsers,
} from "@/db/repositories/admin/clients";
import { listSitesWithAnalytics } from "@/db/repositories/admin/sites";
import { isUmamiConfigured } from "@/lib/analytics/umami";
import { formatCurrency } from "@/lib/payments/venmo";
import { ActivateForm, ReissueForm } from "./credential-forms";
import { AddSiteForm, ConnectAnalyticsForm } from "./site-forms";

export const dynamic = "force-dynamic";

/**
 * One client, and the operator actions that belong to them.
 *
 * Gated twice, like every admin surface: middleware keeps unauthenticated
 * visitors out, and `adminContextFrom` refuses a session that is not an active
 * admin. The second is the load-bearing one.
 *
 * A client that does not exist renders 404 rather than an error, matching the
 * repository's `NotFoundError` contract — admin surfaces have no cross-tenant
 * exposure, but keeping the same shape everywhere means the one place it *does*
 * matter is not a special case someone has to remember.
 */
export default async function ClientDetailPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role !== "admin") redirect("/dashboard");

  const { publicId } = await params;
  const ctx = adminContextFrom(user);
  const db = await getDb();

  let detail;
  try {
    detail = await getClientDetail(ctx, db, publicId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const [portalUsers, siteRows] = await Promise.all([
    listOrganizationUsers(ctx, db, detail.organization.id),
    listSitesWithAnalytics(ctx, db, detail.organization.id),
  ]);

  const { client, organization, subscription, requests } = detail;
  const activated = portalUsers.length > 0;
  const umamiReady = isUmamiConfigured();

  return (
    <AppShell user={user}>
      <main className="shell">
      <div className="masthead">
        <h1>{organization.name}</h1>
        <span className="muted">
          <Link href="/admin/clients">← All clients</Link>
        </span>
      </div>

      {client.isDemo && (
        <p className="notice">
          <span className="badge">Demo</span> This is seeded demo data, not a
          real client.
        </p>
      )}

      <section className="card">
        <h2>Details</h2>
        <dl className="detail-grid">
          <dt>Contact</dt>
          <dd>{client.primaryContactName ?? "—"}</dd>
          <dt>Email</dt>
          <dd>{client.primaryContactEmail ?? "—"}</dd>
          <dt>Phone</dt>
          <dd>{client.phone ?? "—"}</dd>
          <dt>Industry</dt>
          <dd>{client.industry ?? "—"}</dd>
          <dt>Onboarding</dt>
          <dd>{client.onboardingStatus}</dd>
          <dt>Management</dt>
          <dd>
            {client.managementState}
            {client.managementState !== "managed" && (
              <>
                {" — "}
                <span className="muted">
                  the site stays online; only our work is paused
                </span>
              </>
            )}
          </dd>
          <dt>Plan</dt>
          <dd>
            {subscription
              ? `${formatCurrency(subscription.monthlyPriceCents, subscription.currency)}/month, billed on day ${subscription.billingDay}`
              : "No active subscription"}
          </dd>
        </dl>
      </section>

      <section className="card">
        <h2>Portal access</h2>

        {activated ? (
          <>
            <table>
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Last sign-in</th>
                </tr>
              </thead>
              <tbody>
                {portalUsers.map((account) => (
                  <tr key={account.publicId}>
                    <td>
                      <code>{account.username ?? "—"}</code>
                    </td>
                    <td>{account.email}</td>
                    <td>
                      {account.status !== "active"
                        ? account.status
                        : account.mustChangePassword
                          ? "Temporary password not yet used"
                          : "Active"}
                    </td>
                    <td>
                      {account.lastLoginAt
                        ? account.lastLoginAt.toLocaleDateString("en-US")
                        : "Never"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {portalUsers.map((account) => (
              <div key={account.publicId} className="action-block">
                <ReissueForm
                  clientPublicId={client.publicId}
                  userPublicId={account.publicId}
                  email={account.email}
                />
              </div>
            ))}
          </>
        ) : (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              This client cannot sign in yet. Activating creates their account
              and issues a temporary password, shown once.
            </p>
            <div className="action-block">
              <ActivateForm
                clientPublicId={client.publicId}
                defaultName={client.primaryContactName}
                defaultEmail={client.primaryContactEmail}
              />
            </div>
          </>
        )}
      </section>

      <section className="card">
        <h2>Sites &amp; analytics ({siteRows.length})</h2>

        {siteRows.length === 0 ? (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              No site recorded yet. Analytics attaches to a site, so add one
              before connecting Umami.
            </p>
            <div className="action-block">
              <AddSiteForm
                clientPublicId={client.publicId}
                suggestedName={organization.name}
              />
            </div>
          </>
        ) : (
          siteRows.map((site) => (
            <div key={site.publicId} className="action-block">
              <div className="card-head">
                <h2>{site.name}</h2>
                <span
                  className={`pill ${site.umamiWebsiteId ? "pill-success" : "pill-neutral"}`}
                >
                  {site.umamiWebsiteId ? "analytics connected" : "not connected"}
                </span>
              </div>

              <dl className="detail-grid" style={{ marginBottom: "1rem" }}>
                <dt>Domain</dt>
                <dd>{site.primaryDomain ?? "—"}</dd>
                <dt>Status</dt>
                <dd>{site.status}</dd>
              </dl>

              <ConnectAnalyticsForm
                clientPublicId={client.publicId}
                sitePublicId={site.publicId}
                currentWebsiteId={site.umamiWebsiteId}
              />
            </div>
          ))
        )}

        {!umamiReady && (
          <p className="notice" style={{ marginTop: "1.25rem", marginBottom: 0 }}>
            <strong>The portal has no Umami credentials yet.</strong> You can
            record website IDs now, but no figures will load until{" "}
            <code>UMAMI_API_BASE_URL</code> and <code>UMAMI_API_KEY</code> are
            set in the environment.
          </p>
        )}
      </section>

      <section className="card">
        <h2>Recent requests ({requests.length})</h2>
        {requests.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No change requests yet.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Priority</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((request) => (
                <tr key={request.publicId}>
                  <td>{request.title}</td>
                  <td>{request.status}</td>
                  <td>{request.priority}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      </main>
    </AppShell>
  );
}
