import type { ClientReviewsView } from "@/db/repositories/admin/reviews";
import { formatDate } from "@/lib/time";

/**
 * The client's review requests, read-only: whether they set up their Google
 * link, how many went out and were clicked, and the latest few. Changing
 * anything is the client's to do from their own Growth tab; viewing as the
 * client shows exactly what they see.
 */
export function ReviewsSection({ reviews }: { reviews: ClientReviewsView }) {
  const { setup } = reviews;
  return (
    <section className="card" id="reviews">
      <div className="card-head">
        <h2>Review requests</h2>
      </div>
      {setup ? (
        <dl className="detail-grid">
          <dt>Review link</dt>
          <dd>
            <a href={setup.reviewUrl} target="_blank" rel="noreferrer">
              {setup.placeName ?? setup.reviewUrl}
            </a>
          </dd>
          <dt>Reminder</dt>
          <dd>{setup.remindersEnabled ? `After ${setup.reminderDays} days` : "Off"}</dd>
          <dt>Wording</dt>
          <dd>{setup.customised ? "Their own" : "Ours"}</dd>
          <dt>Sent</dt>
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
                <th scope="col">Sent</th>
                <th scope="col">Clicked</th>
                <th scope="col">Reminder</th>
              </tr>
            </thead>
            <tbody>
              {reviews.recent.map((r, i) => (
                <tr key={i}>
                  <td data-label="Customer">{r.customerName}</td>
                  <td data-label="Sent">
                    {r.sentAt ? formatDate(r.sentAt) : `Not sent (${r.emailStatus ?? r.smsStatus ?? "unknown"})`}
                  </td>
                  <td data-label="Clicked">{r.clickedAt ? formatDate(r.clickedAt) : "—"}</td>
                  <td data-label="Reminder">{r.reminderStatus ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
