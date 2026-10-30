import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom, NotFoundError } from "@/db/repositories/context";
import { getGoogleConnectionStatus } from "@/db/repositories/admin/google-connection";
import {
  getGoogleWorkspace,
  listLinkableLocations,
  type GoogleWorkspace,
  type LinkableLocations,
  type WorkspaceReview,
} from "@/db/repositories/admin/google-profile";
import { Checklist, ProfileFacts, Stars } from "@/components/google-profile";
import { describeGoogleError } from "@/lib/google-business/errors";
import { formatDateTime, formatDateWithYear } from "@/lib/time";
import { ActionForm } from "../action-form";
import { linkLocationAction, replyAction, resolveAskAction, syncNowAction, unlinkLocationAction } from "../actions";
import { DescriptionForm, HoursForm, PhotoForm, PostForm, SpecialHoursForm } from "./edit-forms";

/**
 * One client's Google profile, worked on by the operator: link it, answer
 * reviews, change hours and the description, post, add photos, and close the
 * client's asks — with a log of every change and whether Google took it.
 */

export const dynamic = "force-dynamic";

export const metadata = { title: "Google profile", robots: { index: false, follow: false } };

const KIND_LABEL: Record<string, string> = {
  hours: "Hours",
  special_hours: "Special hours",
  description: "Description",
  post: "Post",
  photo: "Photo",
  review_reply: "Review reply",
};

export default async function GoogleWorkspacePage({ params }: { params: Promise<{ clientPublicId: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");
  const ctx = adminContextFrom(user);
  const db = await getDb();
  const { clientPublicId } = await params;

  let workspace: GoogleWorkspace;
  try {
    workspace = await getGoogleWorkspace(ctx, db, clientPublicId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const status = await getGoogleConnectionStatus(db);

  let linkable: LinkableLocations | null = null;
  let linkableError: string | null = null;
  if (!workspace.location && status.state === "connected" && !status.pausedUntil) {
    try {
      linkable = await listLinkableLocations(ctx, db);
    } catch (error) {
      linkableError = describeGoogleError(error);
    }
  }

  const { client, location } = workspace;
  const snapshot = location?.snapshot ?? null;
  const openAsks = workspace.requests.filter((r) => r.status === "open");
  const unanswered = workspace.reviews.filter((r) => r.replyComment === null);
  const answered = workspace.reviews.filter((r) => r.replyComment !== null);
  const canEdit = status.state === "connected";

  return (
    <main className="shell">
      <div className="masthead">
        <h1>
          {client.organizationName}
          <span className="masthead-sub">Google profile</span>
        </h1>
        <span className="muted">
          <Link href={`/admin/clients/${client.publicId}`}>Client page</Link>
        </span>
      </div>

      {client.isDemo && (
        <p className="notice">
          <span className="badge">Demo</span> Seeded demo data, not a real client.
        </p>
      )}
      {!workspace.hasFeature && (
        <p className="notice notice-info">Their plan does not include Google profile management. Add it from their Billing section before doing the work.</p>
      )}
      {status.state !== "connected" && (
        <p className="notice notice-info">
          Google cannot be used right now ({status.state.replace(/_/g, " ")}). What is shown is the last synced copy. <Link href="/admin/google">See the connection</Link>.
        </p>
      )}

      <section className="panel" aria-labelledby="gp-link">
        <div className="panel-head">
          <h2 id="gp-link">Profile</h2>
          {location && (
            <div className="panel-head-actions">
              <ActionForm action={syncNowAction} hidden={{ client: client.publicId }} buttons={[{ label: "Sync now", value: "sync", pendingLabel: "Syncing…", secondary: true }]} />
            </div>
          )}
        </div>
        <div className="panel-body">
          {location ? (
            <>
              <p>
                Linked to <strong>{location.title ?? location.locationName}</strong> <code>{location.locationName}</code>.{" "}
                {location.lastSyncedAt ? <>Synced {formatDateTime(location.lastSyncedAt)}.</> : <>Not synced yet.</>}{" "}
                {location.nextSyncAt ? <span className="muted">Next sync {formatDateTime(location.nextSyncAt)}.</span> : null}
              </p>
              {location.lastSyncError && <p className="notice notice-danger">Last sync failed: {location.lastSyncError}</p>}
              <ActionForm
                action={unlinkLocationAction}
                hidden={{ client: client.publicId }}
                buttons={[{ label: "Unlink", value: "unlink", secondary: true, confirm: "Unlink this profile? Its synced reviews, figures and change log here are deleted. Nothing changes on Google." }]}
              />
            </>
          ) : linkable ? (
            <LinkPicker clientPublicId={client.publicId} linkable={linkable} />
          ) : (
            <p className="muted">
              {linkableError ?? "Not linked. Once Google is connected, profiles the agency manages are listed here to link."}
            </p>
          )}
        </div>
      </section>

      {openAsks.length > 0 && (
        <section className="panel" id="asks" aria-labelledby="gp-asks-head">
          <div className="panel-head">
            <h2 id="gp-asks-head">Client asks ({openAsks.length})</h2>
          </div>
          <div className="panel-body">
            <ul className="gp-asks">
              {openAsks.map((ask) => (
                <li key={ask.publicId}>
                  <div className="gp-ask-head">Sent {formatDateTime(ask.createdAt)}</div>
                  <p className="gp-ask-body">{ask.body}</p>
                  <ActionForm
                    action={resolveAskAction}
                    hidden={{ client: client.publicId, request: ask.publicId }}
                    buttons={[
                      { label: "Mark done", value: "done", pendingLabel: "Saving…" },
                      { label: "Decline", value: "declined", secondary: true },
                    ]}
                  >
                    <label>
                      Note for the client
                      <input name="note" maxLength={1000} placeholder="What you changed, in a line. The client sees this." />
                    </label>
                  </ActionForm>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {snapshot && location && (
        <div className="grid grid-2">
          <section className="card">
            <div className="card-head">
              <h2>On Google</h2>
              {snapshot.mapsUrl && (
                <a href={snapshot.mapsUrl} target="_blank" rel="noreferrer">
                  Open
                </a>
              )}
            </div>
            {snapshot.hasPendingEdits && <p className="notice notice-info">Google is reviewing an edit; it may show something different.</p>}
            <ProfileFacts snapshot={snapshot} />
            <p className="hint">
              {location.averageRating !== null && (
                <>
                  <Stars rating={location.averageRating} /> {location.averageRating.toFixed(1)} from {location.reviewCount ?? 0} reviews ·{" "}
                </>
              )}
              {location.photoCount ?? "?"} photos · {location.lastPostAt ? `last post ${formatDateWithYear(location.lastPostAt)}` : "no posts"}
            </p>
          </section>
          <section className="card">
            <h2>Checklist</h2>
            {location.checklist && <Checklist items={location.checklist} />}
          </section>
        </div>
      )}

      {location && (
        <section className="panel" id="reviews" aria-labelledby="gp-reviews-head">
          <div className="panel-head">
            <h2 id="gp-reviews-head">Reviews</h2>
            <span className="panel-sub">{unanswered.length} waiting for a reply</span>
          </div>
          <div className="panel-body">
            {workspace.reviews.length === 0 ? (
              <p className="muted">No reviews synced.</p>
            ) : (
              <ul className="gp-reviews">
                {unanswered.map((review) => (
                  <ReviewToAnswer key={review.id} clientPublicId={client.publicId} review={review} canPost={canEdit} />
                ))}
                {answered.map((review) => (
                  <li key={review.id} className="gp-review">
                    <ReviewHead review={review} pill={<span className="pill pill-success">Replied</span>} />
                    {review.comment && <p className="gp-review-text">{review.comment}</p>}
                    <p className="gp-reply">
                      <span className="gp-reply-label">Reply{review.repliedAt ? ` · ${formatDateWithYear(review.repliedAt)}` : ""}</span>
                      {review.replyComment}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      {snapshot && canEdit && (
        <>
          <section className="panel" id="post" aria-labelledby="gp-post-head">
            <div className="panel-head">
              <h2 id="gp-post-head">Publish a post</h2>
            </div>
            <div className="panel-body">
              <PostForm clientPublicId={client.publicId} photos={workspace.photos} requests={workspace.requests} />
            </div>
          </section>

          <section className="panel" aria-labelledby="gp-hours-head">
            <div className="panel-head">
              <h2 id="gp-hours-head">Opening hours</h2>
            </div>
            <div className="panel-body">
              <HoursForm clientPublicId={client.publicId} snapshot={snapshot} requests={workspace.requests} />
            </div>
          </section>

          <section className="panel" aria-labelledby="gp-special-head">
            <div className="panel-head">
              <h2 id="gp-special-head">Special hours</h2>
            </div>
            <div className="panel-body">
              <SpecialHoursForm clientPublicId={client.publicId} snapshot={snapshot} requests={workspace.requests} />
            </div>
          </section>

          <div className="grid grid-2">
            <section className="card">
              <h2>Description</h2>
              <DescriptionForm clientPublicId={client.publicId} snapshot={snapshot} requests={workspace.requests} />
            </section>
            <section className="card">
              <h2>Add a photo</h2>
              <PhotoForm clientPublicId={client.publicId} photos={workspace.photos} />
            </section>
          </div>
        </>
      )}

      {location && (
        <section className="panel" aria-labelledby="gp-log-head">
          <div className="panel-head">
            <h2 id="gp-log-head">Change log</h2>
          </div>
          {workspace.changes.length === 0 ? (
            <div className="empty">
              <p>No changes made from the portal yet.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="stack">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>What</th>
                    <th>By</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {workspace.changes.map((change, i) => (
                    <tr key={`${change.createdAt.toISOString()}-${i}`}>
                      <td data-label="When">{formatDateTime(change.createdAt)}</td>
                      <td data-label="What">
                        <span className="muted">{KIND_LABEL[change.kind] ?? change.kind}:</span> {change.summary}
                      </td>
                      <td data-label="By">{change.actorName ?? "—"}</td>
                      <td data-label="Result">
                        {change.status === "applied" ? (
                          <span className="pill pill-success">On Google</span>
                        ) : (
                          <span className="gp-change-failed">Failed: {change.error}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </main>
  );
}

function LinkPicker({ clientPublicId, linkable }: { clientPublicId: string; linkable: LinkableLocations }) {
  const free = linkable.locations.filter((l) => !l.linkedTo);
  if (free.length === 0) {
    return (
      <p className="muted">
        Every profile the agency manages is already linked. Ask the client to add the agency&rsquo;s Google account as a
        Manager{linkable.invitations.length > 0 ? ", then accept the invitation on the Google page" : ""}.
      </p>
    );
  }
  return (
    <ActionForm action={linkLocationAction} hidden={{ client: clientPublicId }} buttons={[{ label: "Link and sync", value: "link", pendingLabel: "Linking…" }]}>
      <label>
        Their Google profile
        <select name="location" required defaultValue="">
          <option value="" disabled>
            Pick a profile
          </option>
          {free.map((l) => (
            <option key={l.name} value={`${l.accountName}|${l.name}`}>
              {l.title}
              {l.address ? ` — ${l.address}` : ""}
            </option>
          ))}
        </select>
      </label>
    </ActionForm>
  );
}

function ReviewHead({ review, pill }: { review: WorkspaceReview; pill: React.ReactNode }) {
  return (
    <div className="gp-review-head">
      <Stars rating={review.starRating} />
      <span className="gp-review-name">{review.reviewerName ?? "A Google user"}</span>
      <span className="gp-review-when">{formatDateWithYear(review.postedAt)}</span>
      {pill}
    </div>
  );
}

function ReviewToAnswer({ clientPublicId, review, canPost }: { clientPublicId: string; review: WorkspaceReview; canPost: boolean }) {
  return (
    <li className="gp-review">
      <ReviewHead review={review} pill={<span className="pill pill-warning">Not replied</span>} />
      {review.comment ? <p className="gp-review-text">{review.comment}</p> : <p className="gp-review-text muted">Rating only.</p>}
      {review.replyError && <p className="error">Last attempt failed: {review.replyError}</p>}
      <ActionForm
        action={replyAction}
        hidden={{ client: clientPublicId, review: review.id }}
        className="gp-reply-form"
        buttons={[
          ...(canPost
            ? [{ label: "Post reply", value: "post", pendingLabel: "Posting…", confirm: "Post this reply on Google under the business's name? It is public." }]
            : []),
          { label: "Save draft", value: "save", secondary: true },
          { label: "Draft again", value: "redraft", secondary: true },
        ]}
      >
        <label>
          Reply
          <textarea name="body" rows={4} maxLength={4096} defaultValue={review.draftReply ?? ""} />
        </label>
        <p className="field-hint">
          {review.draftSource === "operator"
            ? "Your edited draft."
            : "Drafted by the portal from the review and the business's own details. Check it before posting."}{" "}
          Nothing is posted until you press Post reply.
        </p>
      </ActionForm>
    </li>
  );
}
