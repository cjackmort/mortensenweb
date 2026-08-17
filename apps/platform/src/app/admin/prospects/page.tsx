import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { AppShell } from "@/components/app-shell";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import {
  listActivePlans,
  listProspectsDetailed,
} from "@/db/repositories/admin/prospects";
import { isGithubConfigured } from "@/lib/github/app";
import { isNetlifyConfigured } from "@/lib/netlify/api";
import {
  BuildConceptForm,
  NewProspectForm,
  ShareConceptForm,
} from "./forms";

export const dynamic = "force-dynamic";

const PROSPECT_PILL: Record<string, string> = {
  new: "pill-neutral",
  auditing: "pill-info",
  audited: "pill-info",
  concept_pending: "pill-warning",
  concept_ready: "pill-accent",
  shared: "pill-accent",
  converted: "pill-success",
  declined: "pill-neutral",
  expired: "pill-neutral",
};

/** Statuses at which a demo exists and could be shown to someone. */
const SHAREABLE = new Set(["concept_pending", "concept_ready", "shared"]);

/**
 * Potential clients.
 *
 * Admin-only by construction: no client-facing repository anywhere in the
 * codebase reads the `prospects` table, so this data cannot reach a tenant
 * surface even by mistake.
 *
 * The page is the front of the funnel — add a business, pick the plan you mean
 * to pitch, have a demo built, then approve it and get a link to send. Every
 * step after "build" is gated on an operator pressing something; nothing here
 * contacts anybody.
 */
export default async function AdminProspectsPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role !== "admin") redirect("/dashboard");

  const ctx = adminContextFrom(user);
  const db = await getDb();

  const [prospects, plans] = await Promise.all([
    listProspectsDetailed(ctx, db),
    listActivePlans(db),
  ]);

  const githubReady = isGithubConfigured();
  const netlifyReady = isNetlifyConfigured();

  return (
    <AppShell user={user}>
      <main className="shell">
        <div className="masthead">
          <h1>Potential clients</h1>
          <span className="muted">{prospects.length}</span>
        </div>

        {/* Both are named because they fail at different points and the
            distinction decides what an operator should do next. */}
        {(!githubReady || !netlifyReady) && (
          <p className="notice">
            <strong>Demo building is partly unavailable.</strong>{" "}
            {!githubReady && (
              <>
                The GitHub App isn&rsquo;t configured, so no repository can be
                created.{" "}
              </>
            )}
            {!netlifyReady && (
              <>
                Netlify isn&rsquo;t configured, so a repository would be created
                with nowhere to deploy.
              </>
            )}
          </p>
        )}

        <NewProspectForm
          plans={plans.map((plan) => ({
            key: plan.key,
            name: plan.name,
            defaultMonthlyCents: plan.defaultMonthlyCents,
            includedChangesPerMonth: plan.includedChangesPerMonth,
            includesAnalytics: plan.includesAnalytics,
          }))}
        />

        {prospects.length === 0 ? (
          <section className="card">
            <div className="empty">
              <p className="empty-title">No prospects yet.</p>
              <p>
                Businesses you&rsquo;re considering approaching appear here.
              </p>
            </div>
          </section>
        ) : (
          prospects.map((prospect) => (
            <section key={prospect.publicId} className="card">
              <div className="card-head">
                <h2>
                  {prospect.businessName}
                  {prospect.isDemo && (
                    <>
                      {" "}
                      <span className="badge">demo</span>
                    </>
                  )}
                </h2>
                <span
                  className={`pill ${PROSPECT_PILL[prospect.status] ?? "pill-neutral"}`}
                >
                  {prospect.status.replace(/_/g, " ")}
                </span>
              </div>

              <dl className="detail-grid" style={{ marginBottom: "1rem" }}>
                <dt>Plan</dt>
                <dd>{prospect.planName ?? "not chosen"}</dd>
                <dt>Industry</dt>
                <dd>{prospect.industry ?? "—"}</dd>
                <dt>Current site</dt>
                <dd>
                  {prospect.sourceWebsiteUrl ? (
                    // Not a link. These are unvetted third-party URLs, and a
                    // one-click path from an admin session to an arbitrary site
                    // is a needless risk. Copy it if you want to visit.
                    <code style={{ fontSize: "0.8rem", wordBreak: "break-all" }}>
                      {prospect.sourceWebsiteUrl}
                    </code>
                  ) : (
                    "—"
                  )}
                </dd>
                <dt>Updated</dt>
                <dd>
                  {prospect.updatedAt.toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })}
                </dd>
              </dl>

              <div className="action-block">
                {SHAREABLE.has(prospect.status) ? (
                  <ShareConceptForm
                    prospectPublicId={prospect.publicId}
                    hasLiveShare={prospect.status === "shared"}
                  />
                ) : (
                  <BuildConceptForm prospectPublicId={prospect.publicId} />
                )}
              </div>
            </section>
          ))
        )}
      </main>
    </AppShell>
  );
}
