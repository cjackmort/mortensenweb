import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { requireGrowthFeature } from "@/db/repositories/client/growth";
import {
  getGoogleProfileView,
  type ClientGoogleRequest,
  type ClientReview,
  type ReviewReplyState,
} from "@/db/repositories/client/google-profile";
import { Checklist, MetricsPanel, ProfileFacts, Stars } from "@/components/google-profile";
import type { MetricWindow } from "@/lib/google-business/metrics";
import { formatDateTime, formatDateWithYear } from "@/lib/time";
import { AskForChangeForm } from "./ask-form";

/**
 * Google profile management, from the client's side.
 *
 * We do the work; this page shows what their profile says, how it is doing,
 * and takes their asks. It reads the portal's synced copy, never Google
 * directly, and says how old that copy is.
 *
 * Before the profile is linked there is nothing of theirs to show, so the
 * page says what is happening and what (if anything) they need to do — never
 * an empty profile or a row of zeros that could be mistaken for real figures.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Google profile",
  robots: { index: false, follow: false },
};

const REPLY_PILL: Record<ReviewReplyState, { label: string; tone: string }> = {
  replied: { label: "Replied", tone: "pill-success" },
  drafting: { label: "Reply in progress", tone: "pill-info" },
  waiting: { label: "Not replied yet", tone: "pill-warning" },
};

const ASK_PILL: Record<string, { label: string; tone: string }> = {
  open: { label: "With us", tone: "pill-info" },
  done: { label: "Done", tone: "pill-success" },
  declined: { label: "Not done", tone: "pill-neutral" },
};

export default async function GoogleProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
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
  if (!(await requireGrowthFeature(db, ctx, "google-profile"))) {
    redirect("/dashboard/growth?locked=google-profile#google-profile");
  }

  const window: MetricWindow = (await searchParams).range === "90" ? 90 : 30;
  const view = await getGoogleProfileView(db, ctx, { window });
  const readOnly = ctx.impersonating;

  return (
    <main className="shell">
      <div className="masthead">
        <h1>Google profile</h1>
        <span>Your Business Profile on Google Search and Maps, kept current by us</span>
      </div>

      {view.state === "not_linked" ? (
        <NotLinked agencyEmail={view.agencyEmail} />
      ) : !view.synced || !view.snapshot ? (
        <section className="panel">
          <div className="panel-body">
            <p>
              Your profile is linked. The first copy from Google is on its way and shows here within a few hours.
            </p>
          </div>
        </section>
      ) : (
        <>
          {view.snapshot.hasPendingEdits && (
            <p className="notice notice-info">
              Google is reviewing a recent edit, so Google may show something slightly different for a day or two.
            </p>
          )}

          <div className="grid grid-2">
            <section className="card">
              <div className="card-head">
                <h2>What Google shows</h2>
                {view.snapshot.mapsUrl && (
                  <a href={view.snapshot.mapsUrl} target="_blank" rel="noreferrer">
                    Open on Google
                  </a>
                )}
              </div>
              <ProfileFacts snapshot={view.snapshot} />
              {view.lastSyncedAt && <p className="hint">Copied from Google {formatDateTime(view.lastSyncedAt)}.</p>}
            </section>

            <section className="card">
              <h2>Checklist</h2>
              {view.checklist && <Checklist items={view.checklist} />}
            </section>
          </div>

          <MetricsPanel
            metrics={view.metrics}
            searches={view.searches}
            window={window}
            windowHref={(w) => (w === 30 ? "/dashboard/growth/google" : `/dashboard/growth/google?range=${w}`)}
          />

          <section className="panel" aria-labelledby="gp-reviews">
            <div className="panel-head">
              <h2 id="gp-reviews">Reviews</h2>
              {view.averageRating !== null && (
                <span className="panel-sub">
                  <Stars rating={view.averageRating} /> {view.averageRating.toFixed(1)} from {view.reviewCount ?? 0}{" "}
                  {view.reviewCount === 1 ? "review" : "reviews"}
                </span>
              )}
            </div>
            <div className="panel-body">
              {view.reviews.length === 0 ? (
                <p className="muted">No reviews on the profile yet.</p>
              ) : (
                <>
                  {view.unanswered > 0 && (
                    <p className="hint">
                      {view.unanswered} {view.unanswered === 1 ? "review is" : "reviews are"} waiting for a reply. We
                      reply on your behalf.
                    </p>
                  )}
                  <ReviewList reviews={view.reviews} />
                </>
              )}
            </div>
          </section>
        </>
      )}

      <section className="panel" aria-labelledby="gp-ask">
        <div className="panel-head">
          <h2 id="gp-ask">Ask for a change</h2>
        </div>
        <div className="panel-body">
          <AskForChangeForm readOnly={readOnly} />
          <AskList requests={view.requests} />
        </div>
      </section>

      <p className="panel-note">
        <Link href="/dashboard/growth">← Growth</Link>
      </p>
    </main>
  );
}

function NotLinked({ agencyEmail }: { agencyEmail: string | null }) {
  return (
    <section className="panel" aria-labelledby="gp-connect">
      <div className="panel-head">
        <h2 id="gp-connect">Connecting your profile</h2>
      </div>
      <div className="panel-body">
        {agencyEmail ? (
          <>
            <p>
              To let us manage your profile, add <strong>{agencyEmail}</strong> as a Manager. You stay the owner, and
              you can remove us at any time.
            </p>
            <ol className="gp-steps">
              <li>Sign in to Google with the account that owns your Business Profile, and search for your business name.</li>
              <li>On your profile, choose the three dots (⋮), then <strong>Business Profile settings</strong>, then <strong>People and access</strong>.</li>
              <li>
                Choose <strong>Add</strong>, enter <code>{agencyEmail}</code>, pick <strong>Manager</strong>, and send the invite.
              </li>
            </ol>
            <p className="hint">We accept the invite and link your profile here. Your reviews and figures appear after that.</p>
          </>
        ) : (
          <p>
            We are setting up our connection to Google. When it is ready we will ask you to add us as a manager on your
            profile. There is nothing to do yet.
          </p>
        )}
      </div>
    </section>
  );
}

function ReviewList({ reviews }: { reviews: ClientReview[] }) {
  return (
    <ul className="gp-reviews">
      {reviews.map((review, i) => {
        const pill = REPLY_PILL[review.replyState];
        return (
          <li key={`${review.postedAt.toISOString()}-${i}`} className="gp-review">
            <div className="gp-review-head">
              <Stars rating={review.starRating} />
              <span className="gp-review-name">{review.reviewerName ?? "A Google user"}</span>
              <span className="gp-review-when">{formatDateWithYear(review.postedAt)}</span>
              <span className={`pill ${pill.tone}`}>{pill.label}</span>
            </div>
            {review.comment ? <p className="gp-review-text">{review.comment}</p> : <p className="gp-review-text muted">Rating only, no comment.</p>}
            {review.replyComment && (
              <p className="gp-reply">
                <span className="gp-reply-label">Reply</span>
                {review.replyComment}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function AskList({ requests }: { requests: ClientGoogleRequest[] }) {
  if (requests.length === 0) return null;
  return (
    <ul className="gp-asks" aria-label="What you have asked for">
      {requests.map((r) => {
        const pill = ASK_PILL[r.status] ?? ASK_PILL.open!;
        return (
          <li key={r.publicId}>
            <div className="gp-ask-head">
              <span className={`pill ${pill.tone}`}>{pill.label}</span>
              <span>Sent {formatDateTime(r.createdAt)}</span>
              {r.resolvedAt && <span>Closed {formatDateTime(r.resolvedAt)}</span>}
            </div>
            <p className="gp-ask-body">{r.body}</p>
            {r.operatorNote && <p className="gp-ask-note">Our note: {r.operatorNote}</p>}
          </li>
        );
      })}
    </ul>
  );
}
