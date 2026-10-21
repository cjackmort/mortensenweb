import type { ClientReviewsView } from "@/db/repositories/admin/reviews";
import { describeRequest } from "@/lib/reviews/stage";

/**
 * The client's review requests, read-only: whether they set up their Google
 * link, how many went out and were clicked, and the latest few, described in
 * the same words the client's own list uses. Changing anything is the
 * client's to do from their Growth tab; viewing as the client shows exactly
 * what they see.
 */
export function ReviewsSection({ reviews }: { reviews: ClientReviewsView }) {
  const { setup } = reviews;
  return (
    <section className="card" id="reviews">
      <div className="card-head">
        <h2>Review requests</h2>
      </div>
      {setup ? (
        <dl className="detail-grid" style={{ marginBottom: "1.5rem" }}>
          <dt>Review link</dt>
          <dd>
            {reviews.destination?.from === "profile" ? (
              <a href={reviews.destination.url} target="_blank" rel="noreferrer">
                Their Google profile&rsquo;s review form
              </a>
            ) : (
              <a href={setup.reviewUrl} target="_blank" rel="noreferrer">
                {setup.placeName ?? setup.reviewUrl}
              </a>
            )}
          </dd>
          <dt>Reminder</dt>
          <dd>{setup.remindersEnabled ? `After ${setup.reminderDays} days` : "Off"}</dd>
          <dt>Wording</dt>
          <dd>{setup.customised ? "Their own" : "Ours"}</dd>
          <dt>Totals</dt>
          <dd>
            {reviews.sent} sent · {reviews.clicked} clicked · {reviews.reminded} reminded
          </dd>
          <dt>Not to ask</dt>
          <dd>{reviews.suppressed}</dd>
        </dl>
      ) : (
        <p className="muted" style={{ marginTop: 0 }}>
          Not set up. The client adds their Google review link under Growth → Review requests.
        </p>
      )}

      {reviews.recent.length > 0 && (
        <div className="table-wrap">
          <table className="stack">
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col">Status</th>
                <th scope="col">Sent</th>
                <th scope="col">Clicked</th>
                <th scope="col">Reminder</th>
              </tr>
            </thead>
            <tbody>
              {reviews.recent.map((r, i) => {
                const row = describeRequest(r);
                return (
                  <tr key={i}>
                    <td data-label="Customer">{r.customerName}</td>
                    <td data-label="Status">
                      <span className={`pill pill-${row.pill.tone}`}>{row.pill.label}</span>
                    </td>
                    <td data-label="Sent">{row.sent}</td>
                    <td data-label="Clicked">{row.opened}</td>
                    <td data-label="Reminder">{row.reminder}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
