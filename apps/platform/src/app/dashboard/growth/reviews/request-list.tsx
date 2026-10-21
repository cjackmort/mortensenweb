import type { ReviewRequestRow } from "@/db/repositories/client/reviews";
import { describeRequest } from "@/lib/reviews/stage";

/**
 * Who was asked and what happened: one row per request, newest first. Stacks
 * into labelled rows on a phone (`table.stack`), where most clients will read
 * it.
 */
export function ReviewRequestList({ requests }: { requests: ReviewRequestRow[] }) {
  if (requests.length === 0) {
    return (
      <div className="empty">
        <p>No requests yet. Send your first one above — it shows here with whether they clicked.</p>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="stack review-requests">
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
          {requests.map((request) => {
            const row = describeRequest(request);
            return (
              <tr key={request.publicId}>
                <td data-label="Customer">
                  <span className="review-customer">
                    <strong>{request.customerName}</strong>
                    <span className="review-contact">{[request.email, request.phone].filter(Boolean).join(" · ")}</span>
                  </span>
                </td>
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
  );
}
