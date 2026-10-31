"use client";

import { useActionState, useState } from "react";
import { decideAction, type AvailabilityActionResult } from "./actions";

/**
 * Bookings from the website: requests to approve or decline, and confirmed
 * times still to come, which can be cancelled.
 *
 * Every button posts to one action, held once at the top of the list. A
 * decided request leaves the list the moment the page redraws, and the
 * button with it — so the one sentence saying whether the customer was
 * emailed has to live above the rows, not beside the button pressed.
 *
 * Cancelling asks first: it emails the customer and cannot be taken back.
 */

export interface BookingRow {
  publicId: string;
  /** `Thu, Oct 30`. */
  day: string;
  /** `9:00 – 9:30 AM`. */
  time: string;
  name: string;
  email: string;
  phone: string | null;
  note: string | null;
  /** `Asked 2h ago` / `Booked Oct 12`. */
  meta: string;
  /** Set when the last email to the customer about it did not go. */
  emailWarning: string | null;
}

type Dispatch = (payload: FormData) => void;

function Contact({ row }: { row: BookingRow }) {
  return (
    <div className="avail-booking-who">
      <strong className="avail-booking-name">{row.name}</strong>
      <span className="avail-booking-contact">
        <a href={`mailto:${row.email}`}>{row.email}</a>
        {row.phone && (
          <>
            {" · "}
            <a href={`tel:${row.phone.replace(/[^0-9+]/g, "")}`}>{row.phone}</a>
          </>
        )}
      </span>
      {row.note && <p className="avail-booking-note">&ldquo;{row.note}&rdquo;</p>}
      {row.emailWarning && <p className="avail-booking-warning">{row.emailWarning}</p>}
    </div>
  );
}

function When({ row }: { row: BookingRow }) {
  return (
    <div className="avail-booking-when">
      <span className="avail-booking-day">{row.day}</span>
      <span className="avail-booking-time">{row.time}</span>
    </div>
  );
}

function DecisionButton({
  row,
  decision,
  action,
  disabled,
  className,
  label,
  children,
}: {
  row: BookingRow;
  decision: "approve" | "decline" | "cancel";
  action: Dispatch;
  disabled: boolean;
  className?: string;
  /** What the button does and to whom, for a screen reader moving between rows of identical buttons. */
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="booking" value={row.publicId} />
      <input type="hidden" name="decision" value={decision} />
      <button type="submit" className={className} disabled={disabled} aria-label={label}>
        {children}
      </button>
    </form>
  );
}

function Result({ state }: { state: AvailabilityActionResult | null }) {
  if (!state) return null;
  return (
    <p className={state.ok ? "notice notice-success" : "error"} role="status">
      {state.message}
    </p>
  );
}

export function PendingBookings({ rows, readOnly }: { rows: BookingRow[]; readOnly: boolean }) {
  const [state, action, pending] = useActionState<AvailabilityActionResult | null, FormData>(decideAction, null);
  return (
    <>
      <Result state={state} />
      {rows.length === 0 ? (
        <p className="muted avail-empty-line">
          Nothing waiting. When someone asks for a time on your website it appears here, and you&rsquo;re emailed.
        </p>
      ) : (
        <ul className="avail-bookings">
          {rows.map((row) => (
            <li key={row.publicId} className="avail-booking avail-booking--pending">
              <When row={row} />
              <Contact row={row} />
              <div className="avail-booking-actions">
                <DecisionButton
                  row={row}
                  decision="approve"
                  action={action}
                  disabled={readOnly || pending}
                  label={`Accept ${row.name}, ${row.day}, ${row.time}`}
                >
                  Accept
                </DecisionButton>
                <DecisionButton
                  row={row}
                  decision="decline"
                  action={action}
                  disabled={readOnly || pending}
                  className="secondary"
                  label={`Decline ${row.name}, ${row.day}, ${row.time}`}
                >
                  Decline
                </DecisionButton>
                <span className="avail-booking-meta">{row.meta}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function UpcomingBookings({ rows, readOnly }: { rows: BookingRow[]; readOnly: boolean }) {
  const [state, action, pending] = useActionState<AvailabilityActionResult | null, FormData>(decideAction, null);
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <>
      <Result state={state} />
      {rows.length === 0 ? (
        <p className="muted avail-empty-line">No confirmed bookings coming up.</p>
      ) : (
        <ul className="avail-bookings">
          {rows.map((row) => (
            <li key={row.publicId} className="avail-booking">
              <When row={row} />
              <Contact row={row} />
              <div className="avail-booking-actions">
                {confirming === row.publicId ? (
                  <>
                    <span className="avail-booking-ask">Cancel and email {row.name}?</span>
                    <DecisionButton row={row} decision="cancel" action={action} disabled={readOnly || pending} className="danger small">
                      {pending ? "Cancelling…" : "Yes, cancel"}
                    </DecisionButton>
                    <button type="button" className="secondary small" onClick={() => setConfirming(null)} disabled={pending}>
                      Keep it
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="secondary small"
                      disabled={readOnly || pending}
                      onClick={() => setConfirming(row.publicId)}
                    >
                      Cancel
                    </button>
                    <span className="avail-booking-meta">{row.meta}</span>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
