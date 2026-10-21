import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { requireGrowthFeature } from "@/db/repositories/client/growth";
import { getGoogleReviewStats } from "@/db/repositories/client/google-profile";
import {
  getReviewDestination,
  getReviewSetup,
  listLeadsForReview,
  listReviewRequests,
  reviewSummary,
  type ReviewSummary,
} from "@/db/repositories/client/reviews";
import { reviewSenderIdentity } from "@/db/repositories/client/review-send";
import { placesConfigured } from "@/lib/reviews/places";
import { smsConfigured } from "@/lib/reviews/sms";
import { formatDate } from "@/lib/time";
import { GoogleRating } from "./google-rating";
import { ReviewRequestList } from "./request-list";
import { SendReviewForm, type LeadChoice } from "./send-form";
import { ReviewLinkForm } from "./setup-form";
import "./reviews.css";

/**
 * Review requests: ask a customer for a Google review, see who clicked.
 *
 * Before the business has a review link, the page is the setup and nothing
 * else — there is nothing to send until customers have somewhere to go.
 * After, it is the send form, the totals, and the list.
 *
 * There is deliberately no "how was it?" step anywhere. Google forbids
 * filtering who is asked for a review, so every request carries the link.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Review requests",
  robots: { index: false, follow: false },
};

function percent(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

function Totals({ summary }: { summary: ReviewSummary }) {
  const tiles = [
    { label: "Sent", value: String(summary.sent), note: "Requests that went out" },
    { label: "Clicked", value: String(summary.clicked), note: "Opened the review link" },
    { label: "Click rate", value: percent(summary.clickRate), note: summary.clickRate === null ? "Nothing sent yet" : "Of those sent" },
    { label: "Reminded", value: String(summary.reminded), note: "One reminder each, at most" },
  ];
  return (
    <div className="metrics">
      {tiles.map((tile) => (
        <div className="metric" key={tile.label}>
          <p className="metric-label">{tile.label}</p>
          <p className="metric-value">{tile.value}</p>
          <p className="metric-note">{tile.note}</p>
        </div>
      ))}
    </div>
  );
}

function leadLabel(lead: { name: string | null; email: string | null; phone: string | null; receivedAt: Date }) {
  const who = lead.name ?? lead.email ?? lead.phone ?? "Someone";
  return `${who} — enquiry ${formatDate(lead.receivedAt)}`;
}

export default async function ReviewRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ lead?: string; page?: string }>;
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
  if (!(await requireGrowthFeature(db, ctx, "reviews"))) redirect("/dashboard/growth?locked=reviews#reviews");

  const params = await searchParams;
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);
  const setup = await getReviewSetup(db, ctx);
  const readOnly = ctx.impersonating;

  if (!setup) {
    // A linked Google profile already knows its review form: offer it, so
    // setting up is one click instead of a hunt through Google's menus.
    const fromProfile = await getReviewDestination(db, ctx, null);
    return (
      <main className="shell">
        <div className="masthead">
          <h1>Review requests</h1>
          <span>Ask customers for a Google review</span>
        </div>
        <section className="panel">
          <div className="panel-head">
            <h2>First, your Google review link</h2>
          </div>
          <div className="panel-body">
            <p className="muted" style={{ marginTop: 0 }}>
              This is where the &ldquo;Leave a review&rdquo; button in every request goes. You set it once.
            </p>
            {fromProfile && (
              <p className="notice" role="status">
                We filled in the review link from your Google profile. Save it to start asking.
              </p>
            )}
            <ReviewLinkForm current={fromProfile?.url ?? null} placesEnabled={placesConfigured()} readOnly={readOnly} />
          </div>
        </section>
      </main>
    );
  }

  const [summary, { requests, hasMore }, leadRows, identity] = await Promise.all([
    reviewSummary(db, ctx),
    listReviewRequests(db, ctx, { page }),
    listLeadsForReview(db, ctx),
    reviewSenderIdentity(db, ctx),
  ]);
  const leads: LeadChoice[] = leadRows.map((lead) => ({
    publicId: lead.publicId,
    label: leadLabel(lead),
    name: lead.name ?? "",
    email: lead.email ?? "",
    phone: lead.phone ?? "",
  }));
  const reminderNote = setup.remindersEnabled
    ? `If they don't click, we remind them once after ${setup.reminderDays} ${setup.reminderDays === 1 ? "day" : "days"}.`
    : "Reminders are off.";

  return (
    <main className="shell">
      <div className="masthead">
        <h1>Review requests</h1>
        <span>Ask customers for a Google review</span>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Ask for a review</h2>
          <div className="panel-head-actions">
            <Link href="/dashboard/growth/reviews/settings">Wording and settings</Link>
          </div>
        </div>
        <div className="panel-body">
          <SendReviewForm
            leads={leads}
            initialLead={params.lead ?? null}
            smsEnabled={smsConfigured()}
            businessName={identity.businessName}
            replyTo={identity.replyTo}
            reminderNote={reminderNote}
            readOnly={readOnly}
          />
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>How it&rsquo;s going</h2>
          <Suspense fallback={null}>
            <GoogleRating placeId={setup.placeId} linkedProfile={() => getGoogleReviewStats(db, ctx)} />
          </Suspense>
        </div>
        <Totals summary={summary} />
        <div className="panel-body">
          <ReviewRequestList requests={requests} />
          {(page > 1 || hasMore) && (
            <div className="lead-pager">
              {page > 1 ? <Link href={`/dashboard/growth/reviews?page=${page - 1}`}>← Newer</Link> : <span />}
              {hasMore && <Link href={`/dashboard/growth/reviews?page=${page + 1}`}>Older →</Link>}
            </div>
          )}
          <p className="hint">
            &ldquo;Clicked&rdquo; means they opened your review link. Google does not tell us whether they then
            posted a review.
          </p>
        </div>
      </section>
    </main>
  );
}
