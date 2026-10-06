import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import {
  listChangeRequests,
  listRequestTimelines,
  listSites,
} from "@/db/repositories/client/change-requests";
import {
  getAllowance,
  getEntitlements,
} from "@/db/repositories/client/entitlements";
import { listPreviewsAwaitingDecision } from "@/db/repositories/client/previews";
import {
  listAssets,
  listFolderOptions,
} from "@/db/repositories/client/media-assets";
import { RequestProgress } from "@/components/request-progress";
import { RequestTimeline } from "@/components/request-timeline";
import { isCancellable, isOpen, stageIndex } from "@/lib/requests/status";
import { formatDate } from "@/lib/time";
import { plainSummary } from "@/lib/requests/summary";
import { RequestForm } from "./request-form";
import { PreviewPanel } from "./preview-panel";
import { CancelRequestButton } from "./cancel-button";
import { NoteForm } from "./note-form";

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
      <>
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
      </>
    );
  }

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  const [
    sites,
    requests,
    entitlements,
    allowance,
    previews,
    pickableAssets,
    pickableFolders,
  ] = await Promise.all([
    listSites(db, ctx),
    listChangeRequests(db, ctx, { limit: 50 }),
    getEntitlements(db, ctx),
    getAllowance(db, ctx),
    listPreviewsAwaitingDecision(db, ctx),
    // Bounded. A client with a thousand images should not have all of them
    // serialised into this page — the library itself is where you browse, and
    // the picker is for reaching for something recent.
    listAssets(db, ctx, { readyOnly: true, limit: 120 }),
    listFolderOptions(db, ctx),
  ]);

  const timelines = await listRequestTimelines(
    db,
    ctx,
    requests.map((r) => r.publicId),
  );

  // No client record at all is treated as unlocked rather than locked. That
  // case is a gap on our side, and the proportionate response to our own gap
  // is not to block someone out of the thing they are paying for.
  const locked = entitlements ? !entitlements.changeRequestsUnlocked : false;

  const inProgress = requests.filter((r) => isOpen(r.status));
  const finished = requests.filter((r) => !isOpen(r.status));

  return (
    <>
      <main className="shell">
        <div className="masthead">
          <h1>Requests</h1>
        </div>
        <p className="page-intro">
          Ask for anything you&rsquo;d like changed on your site. You&rsquo;ll
          see it on a preview before anything changes.
        </p>

        {/* Above the form on purpose: something waiting on the client's
            decision is more urgent than raising something new, and burying it
            under the form is how a preview sits unapproved for a week. */}
        <PreviewPanel
          items={previews.map((preview) => ({
            requestPublicId: preview.requestPublicId,
            requestTitle: preview.requestTitle,
            previewUrl: preview.previewUrl,
            // What was changed, in the agent's words, beside the buttons
            // that decide on it — so a client on a phone can often approve
            // without hunting for the change in the preview.
            summary: plainSummary(
              timelines
                .get(preview.requestPublicId)
                ?.filter((e) => e.kind === "agent_summary")
                .at(-1)?.body,
            ),
          }))}
        />

        <RequestForm
          sites={sites.map((s) => ({ publicId: s.publicId, name: s.name }))}
          locked={locked}
          /* Only `ready` images are offered. One still processing has no
             thumbnail and could not be used by an agent, so offering it would
             be inviting a client to choose something that will be refused at
             submit. */
          assets={pickableAssets.map((asset) => ({
            publicId: asset.publicId,
            title: asset.title ?? asset.originalFilename,
            filename: asset.originalFilename,
            width: asset.width,
            height: asset.height,
            hasThumbnail: asset.hasThumbnail,
            folderPublicId: asset.folderPublicId,
          }))}
          folders={pickableFolders}
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

        {/* Folded by default. The form is what this page is for; the history is
            there when someone wants it, with a count that says whether
            anything is still moving. In progress first, then finished. */}
        <details className="panel panel-fold" id="your-changes">
          <summary className="panel-head">
            <h2>Your changes</h2>
            <span className="panel-sub">
              {requests.length === 0
                ? "nothing yet"
                : [
                    inProgress.length > 0 ? `${inProgress.length} in progress` : null,
                    finished.length > 0 ? `${finished.length} finished` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
            </span>
          </summary>

          <div className="panel-body">
            {requests.length === 0 ? (
              <div className="empty">
                <p className="empty-title">Nothing yet.</p>
                <p>Anything you send will appear here so you can follow it.</p>
              </div>
            ) : (
              [...inProgress, ...finished].map((request) => (
                <RequestHistoryItem
                  key={request.publicId}
                  request={request}
                  timeline={timelines.get(request.publicId) ?? []}
                />
              ))
            )}
          </div>
        </details>
      </main>
    </>
  );
}

type RequestRow = Awaited<ReturnType<typeof listChangeRequests>>[number];
type TimelineRows = Awaited<ReturnType<typeof listRequestTimelines>> extends Map<string, infer T>
  ? T
  : never;

/** One request in "Your changes": where it is, what happened, what they can do. */
function RequestHistoryItem({
  request,
  timeline,
}: {
  request: RequestRow;
  timeline: TimelineRows;
}) {
  // A preview the operator has not released yet is, from where the client
  // stands, still being made — not something waiting on them.
  const status =
    request.status === "pr_open" && !request.previewReleased ? "dispatched" : request.status;

  return (
    <div
      // The target of the "in progress: …" link on the form above.
      id={`request-${request.publicId}`}
      className="request-item"
      style={{ scrollMarginTop: "7rem" }}
    >
      <div className="request-head">
        <p className="request-title">{request.title}</p>
        <span className="muted" style={{ fontSize: "0.8rem" }}>
          sent {formatDate(request.createdAt)}
        </span>
      </div>
      <RequestProgress status={status} stage={stageIndex(status)} />

      {/* A link only — approving stays in the panel at the top, because two
          Apply buttons for the same change is a way to click the wrong one. */}
      {request.previewUrl && (
        <p style={{ margin: "0.6rem 0 0", fontSize: "0.92rem" }}>
          <a href={request.previewUrl} target="_blank" rel="noopener noreferrer">
            See this change
          </a>
          <span className="muted">
            {request.previewDecision === "approved"
              ? " — you approved this"
              : request.previewDecision === "changes_requested"
                ? " — you asked for more changes"
                : " — waiting for your decision at the top"}
          </span>
        </p>
      )}

      <RequestTimeline entries={timeline} />

      {/* Offered only where the server would honour it — see
          `isCancellable`. A change that has already merged is past the point
          of calling off. */}
      {isCancellable(request.status) && (
        <>
          <NoteForm requestPublicId={request.publicId} />
          <CancelRequestButton
            requestPublicId={request.publicId}
            hasPreview={Boolean(request.previewUrl)}
          />
        </>
      )}
    </div>
  );
}
