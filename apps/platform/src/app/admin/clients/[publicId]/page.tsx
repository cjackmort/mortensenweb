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
import { listClientPaymentRequests } from "@/db/repositories/admin/billing";
import { isUmamiConfigured } from "@/lib/analytics/umami";
import { formatCurrency } from "@/lib/payments/venmo";
import { listBriefs } from "@/db/repositories/admin/briefs";
import { ActivateForm, ReissueForm } from "./credential-forms";
import { AddSiteForm, ConnectAnalyticsForm } from "./site-forms";
import { ConfirmReceivedForm, RaiseRequestForm } from "./billing-forms";
import { BriefForm, DispatchBriefForm } from "./brief-forms";
import { LaunchPanel } from "./launch-forms";
import { RepositoryPanel } from "./repo-forms";
import { CompPanel } from "./comp-forms";
import { listActivePlans } from "@/db/repositories/admin/prospects";
import { getClientComp } from "@/db/repositories/admin/clients";

const BRIEF_PILL: Record<string, string> = {
  draft: "pill-neutral",
  submitted: "pill-info",
  dispatched: "pill-accent",
  applied: "pill-success",
  cancelled: "pill-neutral",
};

const INVOICE_PILL: Record<string, string> = {
  draft: "pill-neutral",
  open: "pill-info",
  awaiting_confirmation: "pill-warning",
  paid: "pill-success",
  overdue: "pill-danger",
  cancelled: "pill-neutral",
  written_off: "pill-neutral",
};

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

  const [portalUsers, siteRows, invoices, briefs, compPlans, comp] = await Promise.all([
    listOrganizationUsers(ctx, db, detail.organization.id),
    listSitesWithAnalytics(ctx, db, detail.organization.id),
    listClientPaymentRequests(ctx, db, detail.organization.id),
    listBriefs(ctx, db, detail.organization.id),
    listActivePlans(db),
    getClientComp(ctx, db, publicId),
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
                <dt>Repository</dt>
                <dd>
                  {site.repoOwner
                    ? `${site.repoOwner}/${site.repoName}`
                    : "not connected"}
                </dd>
                <dt>Hosting</dt>
                <dd>{site.netlifySiteName ?? "not set up"}</dd>
              </dl>

              <ConnectAnalyticsForm
                clientPublicId={client.publicId}
                sitePublicId={site.publicId}
                currentWebsiteId={site.umamiWebsiteId}
              />

              <div style={{ marginTop: "1.5rem" }}>
                <RepositoryPanel
                  sitePublicId={site.publicId}
                  siteName={site.name}
                  connected={
                    site.repoOwner && site.repoName
                      ? {
                          owner: site.repoOwner,
                          name: site.repoName,
                          defaultBranch: site.repoDefaultBranch ?? "main",
                          allowlisted: site.automationEnabled ?? false,
                          previewUrlStyle: site.previewUrlStyle ?? "pr_alias",
                          netlifySiteName: site.netlifySiteName ?? null,
                        }
                      : null
                  }
                />
              </div>

              <div style={{ marginTop: "1.5rem" }}>
                <h3 style={{ fontSize: "0.95rem" }}>Launch</h3>
                <LaunchPanel
                  sitePublicId={site.publicId}
                  clientPublicId={client.publicId}
                  domain={site.primaryDomain}
                  status={site.status}
                  dnsSentAt={site.dnsInstructionsSentAt}
                  liveVerifiedAt={site.liveVerifiedAt}
                  automationEnabled={site.automationEnabled ?? false}
                  hasRepository={Boolean(site.repoOwner)}
                />
              </div>
            </div>
          ))
        )}

        <CompPanel
          clientPublicId={client.publicId}
          plans={compPlans.map((p) => ({
            key: p.key,
            name: p.name,
            includedChangesPerMonth: p.includedChangesPerMonth,
          }))}
          currentCompPlanId={comp?.compPlanKey ?? null}
          currentNote={comp?.compNote ?? null}
          paidPlanName={comp?.paidPlanName ?? null}
        />

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
        <div className="card-head">
          <h2>What they asked for</h2>
          <span className="muted">{briefs.length}</span>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          Type what came out of the call. Pressing <em>Save and build</em> hands
          it to the agent, which opens a pull request and builds a preview — the
          client approves that preview before anything goes live.
        </p>

        <div className="action-block">
          <BriefForm
            clientPublicId={client.publicId}
            sites={siteRows.map((site) => ({
              publicId: site.publicId,
              name: site.name,
            }))}
            hasSite={siteRows.length > 0}
          />
        </div>

        {briefs.length > 0 && (
          <div className="table-wrap">
            <table className="stack">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Summary</th>
                  <th>Status</th>
                  <th>Written</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {briefs.map((brief) => (
                  <tr key={brief.publicId}>
                    <td data-label="Kind">{brief.kind}</td>
                    <td data-label="Summary">
                      {/* First line only. The full text is in the issue, and a
                          wall of call notes in a table row helps nobody. */}
                      {(
                        brief.features ??
                        brief.colourDirection ??
                        brief.contentNotes ??
                        brief.body ??
                        ""
                      )
                        .split("\n")[0]
                        ?.slice(0, 90) || "—"}
                    </td>
                    <td data-label="Status">
                      <span
                        className={`pill ${BRIEF_PILL[brief.status] ?? "pill-neutral"}`}
                      >
                        {brief.status}
                      </span>
                    </td>
                    <td data-label="Written">
                      {brief.createdAt.toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </td>
                    <td data-label="">
                      {brief.status === "draft" && (
                        <DispatchBriefForm
                          briefPublicId={brief.publicId}
                          clientPublicId={client.publicId}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Billing</h2>
          {subscription && (
            <span className="muted">
              {formatCurrency(subscription.monthlyPriceCents)}/month
            </span>
          )}
        </div>

        {invoices.length === 0 ? (
          <p className="muted" style={{ marginTop: 0 }}>
            No payment requests yet.
          </p>
        ) : (
          <div className="table-wrap" style={{ marginBottom: "1.25rem" }}>
            <table className="stack">
              <thead>
                <tr>
                  <th>Ref</th>
                  <th>Amount</th>
                  <th>Due</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.publicId}>
                    <td data-label="Ref">
                      <code>{inv.reference}</code>
                    </td>
                    <td data-label="Amount">
                      {formatCurrency(inv.amountCents, inv.currency)}
                    </td>
                    <td data-label="Due">{inv.dueOn ?? "—"}</td>
                    <td data-label="Status">
                      <span
                        className={`pill ${INVOICE_PILL[inv.status] ?? "pill-neutral"}`}
                      >
                        {inv.status.replace(/_/g, " ")}
                      </span>
                      {inv.status === "awaiting_confirmation" && (
                        <div
                          className="muted"
                          style={{ fontSize: "0.8rem", marginTop: "0.2rem" }}
                        >
                          Client says they paid — not being chased
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Confirmation sits with the specific invoice it settles, so an
            operator cannot confirm the wrong one from a shared form. */}
        {invoices
          .filter((inv) =>
            ["open", "overdue", "awaiting_confirmation"].includes(inv.status),
          )
          .map((inv) => (
            <div key={inv.publicId} className="action-block">
              <ConfirmReceivedForm
                clientPublicId={client.publicId}
                requestPublicId={inv.publicId}
                reference={inv.reference}
                amount={formatCurrency(inv.amountCents, inv.currency)}
              />
            </div>
          ))}

        <div className="action-block">
          <RaiseRequestForm
            clientPublicId={client.publicId}
            suggestedAmount={
              subscription
                ? (subscription.monthlyPriceCents / 100).toFixed(2)
                : ""
            }
          />
        </div>
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
