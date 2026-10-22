import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { requireGrowthFeature } from "@/db/repositories/client/growth";
import { getReviewSetup, listReviewSuppressions, type ReviewSuppression } from "@/db/repositories/client/reviews";
import { placesConfigured } from "@/lib/reviews/places";
import { formatDate } from "@/lib/time";
import { ReviewMessageForm } from "../message-form";
import { ReviewLinkForm } from "../setup-form";
import { AddSuppressionForm, RemoveSuppressionButton } from "../suppression-forms";
import "../reviews.css";

/**
 * Everything about review requests that is set once: the Google link, the
 * wording and reminder, and the people the business must not ask.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Review request settings",
  robots: { index: false, follow: false },
};

const REASON: Record<ReviewSuppression["reason"], string> = {
  unsubscribed: "Unsubscribed",
  sms_opt_out: "Replied STOP",
  bounced: "Email bounced",
  complained: "Marked as spam",
  manual: "Added by you",
};

export default async function ReviewSettingsPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.organizationId) redirect("/dashboard");

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  if (!(await requireGrowthFeature(db, ctx, "reviews"))) redirect("/dashboard/growth?locked=reviews#reviews");

  const setup = await getReviewSetup(db, ctx);
  if (!setup) redirect("/dashboard/growth/reviews");
  const suppressions = await listReviewSuppressions(db, ctx);
  const readOnly = ctx.impersonating;

  return (
    <main className="shell">
      <div className="masthead">
        <h1>
          Review requests<span className="masthead-sub">Settings</span>
        </h1>
        <span className="muted">
          <Link href="/dashboard/growth/reviews">← Back to requests</Link>
        </span>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Your Google review link</h2>
          <div className="panel-head-actions">
            <a href={setup.reviewUrl} target="_blank" rel="noreferrer">
              Open it to check
            </a>
          </div>
        </div>
        <div className="panel-body">
          {setup.placeName && (
            <p className="muted" style={{ marginTop: 0 }}>
              Google lists this as <strong>{setup.placeName}</strong>.
            </p>
          )}
          <ReviewLinkForm current={setup.reviewUrl} placesEnabled={placesConfigured()} readOnly={readOnly} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>The message</h2>
          {!setup.customised && <span className="panel-sub">Our wording</span>}
        </div>
        <div className="panel-body">
          <ReviewMessageForm
            template={setup.template}
            reminderDays={setup.reminderDays}
            remindersEnabled={setup.remindersEnabled}
            readOnly={readOnly}
          />
        </div>
      </section>

      <section className="panel" id="not-to-ask">
        <div className="panel-head">
          <h2>People not to ask</h2>
        </div>
        <div className="panel-body">
          <p className="muted" style={{ marginTop: 0 }}>
            Checked before every request and every reminder. Someone who unsubscribed, replied STOP or marked an
            email as spam stays here: only they can change that. So does an address that bounced, because it will
            bounce again.
          </p>
          {suppressions.length > 0 && (
            <ul className="review-suppressions">
              {suppressions.map((s) => (
                <li key={`${s.channel}:${s.address}`}>
                  <span>
                    <strong>{s.address}</strong>
                    <span className="muted">
                      {" "}
                      · {REASON[s.reason]} {formatDate(s.createdAt)}
                    </span>
                  </span>
                  {s.reason === "manual" && (
                    <RemoveSuppressionButton channel={s.channel} address={s.address} readOnly={readOnly} />
                  )}
                </li>
              ))}
            </ul>
          )}
          <AddSuppressionForm readOnly={readOnly} />
        </div>
      </section>
    </main>
  );
}
