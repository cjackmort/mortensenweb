import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { AppShell } from "@/components/app-shell";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import {
  listChangeRequests,
  listSites,
} from "@/db/repositories/client/change-requests";
import {
  getAllowance,
  getEntitlements,
} from "@/db/repositories/client/entitlements";
import { listPreviewsAwaitingDecision } from "@/db/repositories/client/previews";
import { RequestProgress } from "@/components/request-progress";
import { stageIndex } from "@/lib/requests/status";
import { RequestForm } from "./request-form";
import { PreviewPanel } from "./preview-panel";

export const dynamic = "force-dynamic";

/**
 * The client's change requests, and the form to raise one.
 *
 * Both the list and the form go through `TenantContext`, so there is no code
 * path here that reads or writes another organization's rows.
 */
export default async function ClientRequestsPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role === "admin") redirect("/admin");

  if (!user.organizationId) {
    return (
      <AppShell user={user}>
        <main className="shell">
          <div className="masthead">
            <h1>Requests</h1>
          </div>
          <p className="notice">
            Your account is not yet linked to an organization, so requests
            cannot be raised. Please contact us and we&rsquo;ll finish setting
            it up.
          </p>
        </main>
      </AppShell>
    );
  }

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  const [sites, requests, entitlements, allowance, previews] = await Promise.all(
    [
      listSites(db, ctx),
      listChangeRequests(db, ctx, { limit: 50 }),
      getEntitlements(db, ctx),
      getAllowance(db, ctx),
      listPreviewsAwaitingDecision(db, ctx),
    ],
  );

  // No client record at all is treated as unlocked rather than locked. That
  // case is a gap on our side, and the proportionate response to our own gap
  // is not to block someone out of the thing they are paying for.
  const locked = entitlements ? !entitlements.changeRequestsUnlocked : false;

  return (
    <AppShell user={user}>
      <main className="shell">
        <div className="masthead">
          <h1>Requests</h1>
        </div>
        <p className="page-intro">
          Ask for anything you&rsquo;d like changed on your site. Photos help —
          a picture of the thing you mean is usually faster than describing it.
        </p>

        {/* Above the form on purpose: something waiting on the client's
            decision is more urgent than raising something new, and burying it
            under the form is how a preview sits unapproved for a week. */}
        <PreviewPanel
          items={previews.map((preview) => ({
            requestPublicId: preview.requestPublicId,
            requestTitle: preview.requestTitle,
            previewUrl: preview.previewUrl,
          }))}
        />

        <RequestForm
          sites={sites.map((s) => ({ publicId: s.publicId, name: s.name }))}
          locked={locked}
          allowance={
            allowance
              ? {
                  included: allowance.included,
                  used: allowance.used,
                  remaining: allowance.remaining,
                  label: allowance.label,
                  overagePerChangeCents: allowance.overagePerChangeCents,
                }
              : null
          }
        />

        <section className="card">
          <div className="card-head">
            <h2>Your requests</h2>
            <span className="muted">{requests.length} total</span>
          </div>

          {requests.length === 0 ? (
            <div className="empty">
              <p className="empty-title">Nothing yet.</p>
              <p>Anything you send will appear here so you can follow it.</p>
            </div>
          ) : (
            requests.map((request) => (
              <div key={request.publicId} className="request-item">
                <div className="request-head">
                  <p className="request-title">{request.title}</p>
                  <span className="muted" style={{ fontSize: "0.8rem" }}>
                    {(request.priority === "urgent" ||
                      request.priority === "high") && (
                      <>
                        <span className="pill pill-warning">
                          {request.priority}
                        </span>{" "}
                      </>
                    )}
                    sent{" "}
                    {request.createdAt.toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                </div>
                <RequestProgress
                  status={request.status}
                  stage={stageIndex(request.status)}
                />

                {/* The preview, where someone actually looks for it.
                    The panel above is the call to action for something
                    awaiting a decision; this is the record of a request they
                    scrolled down to check on. A link only — approving stays
                    in one place, because two Apply buttons for the same
                    change is a way to click the wrong one. */}
                {request.previewUrl && (
                  <p style={{ margin: "0.6rem 0 0", fontSize: "0.9rem" }}>
                    <a
                      href={request.previewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      See this change
                    </a>
                    {request.previewDecision === "approved" ? (
                      <span className="muted"> &mdash; you approved this</span>
                    ) : request.previewDecision === "changes_requested" ? (
                      <span className="muted">
                        {" "}
                        &mdash; you asked for more changes
                      </span>
                    ) : (
                      <span className="muted">
                        {" "}
                        &mdash; waiting for your decision above
                      </span>
                    )}
                  </p>
                )}
              </div>
            ))
          )}
        </section>
      </main>
    </AppShell>
  );
}
