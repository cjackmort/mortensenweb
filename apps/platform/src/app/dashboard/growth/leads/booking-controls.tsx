"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { bookingAction, type LeadActionResult } from "./actions";

/**
 * Approve or decline a performer's booking request.
 *
 * Approving is the one action here that reaches outside the portal — it
 * emails the performer and puts their show on the client's website — so the
 * button says both. Declining sends nothing; the reply box is right below for
 * a client who wants to say no kindly.
 *
 * Every button posts to one action, held once at the top of the panel. When
 * an approval lands, the panel redraws as "Booked" and the form that was
 * pressed is gone — the result has to live above it, or the one sentence
 * saying whether the band was emailed would vanish with the form.
 */

export interface BookingView {
  decision: "approved" | "declined";
  eventDate: string | null;
  startTime: string | null;
  emailStatus: "sent" | "failed" | "not_sent" | null;
  hasLogo: boolean;
  removed: boolean;
  /** Pre-formatted on the server, in the business's timezone. */
  decidedOn: string;
  /** `Saturday, November 14, 2026 · 9 PM`, pre-formatted. */
  showsOn: string | null;
}

type Action = (payload: FormData) => void;

function Result({ state }: { state: LeadActionResult | null }) {
  if (!state) return null;
  return (
    <p className={state.ok ? "notice notice-success" : "error"} role="status">
      {state.message}
    </p>
  );
}

function OpButton({
  publicId,
  op,
  action,
  disabled,
  className,
  children,
}: {
  publicId: string;
  op: "decline" | "unlist" | "relist";
  action: Action;
  disabled: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="lead" value={publicId} />
      <input type="hidden" name="op" value={op} />
      <button type="submit" className={className ?? "secondary"} disabled={disabled}>
        {children}
      </button>
    </form>
  );
}

function ApproveForm({
  publicId,
  defaultDate,
  today,
  action,
  disabled,
  pending,
  label,
}: {
  publicId: string;
  defaultDate: string;
  today: string;
  action: Action;
  disabled: boolean;
  pending: boolean;
  label: string;
}) {
  return (
    <form action={action} className="booking-approve">
      <input type="hidden" name="lead" value={publicId} />
      <input type="hidden" name="op" value="approve" />
      <div className="booking-when">
        <div>
          <label htmlFor={`date-${publicId}`}>Date they play</label>
          <input
            id={`date-${publicId}`}
            type="date"
            name="date"
            min={today}
            defaultValue={defaultDate}
            required
          />
        </div>
        <div>
          <label htmlFor={`time-${publicId}`}>
            Start time <span className="muted">(optional)</span>
          </label>
          <input id={`time-${publicId}`} type="time" name="time" step={900} />
        </div>
      </div>
      <button type="submit" disabled={disabled}>
        {pending ? "Approving…" : label}
      </button>
    </form>
  );
}

const EMAILED: Record<NonNullable<BookingView["emailStatus"]>, string> = {
  sent: "They were emailed.",
  failed: "The email to them didn't go through — reply to them below.",
  not_sent: "They weren't emailed.",
};

/** The decision panel on one booking request. */
export function BookingDecision({
  publicId,
  requestedDate,
  today,
  booking,
  readOnly,
}: {
  publicId: string;
  requestedDate: string | null;
  today: string;
  booking: BookingView | null;
  readOnly: boolean;
}) {
  const [state, action, pending] = useActionState<LeadActionResult | null, FormData>(bookingAction, null);
  const disabled = pending || readOnly;
  const suggested = requestedDate && requestedDate >= today ? requestedDate : "";

  if (booking?.decision === "approved" && !booking.removed) {
    return (
      <div className="booking-decided">
        <Result state={state} />
        <p className="booking-status">
          <span className="pill pill-success">Booked</span> On your events page for{" "}
          <strong>{booking.showsOn}</strong>. {booking.emailStatus ? EMAILED[booking.emailStatus] : null}{" "}
          {booking.hasLogo ? null : "No logo on the site — it shows their name instead."}
        </p>
        <div className="actions">
          <OpButton publicId={publicId} op="unlist" action={action} disabled={disabled}>
            Take it off the site
          </OpButton>
          <OpButton publicId={publicId} op="decline" action={action} disabled={disabled}>
            Decline
          </OpButton>
        </div>
      </div>
    );
  }

  return (
    <div className="booking-decided">
      <Result state={state} />
      {booking?.decision === "declined" && (
        <p className="booking-status">
          <span className="pill pill-neutral">Declined</span> You declined this on {booking.decidedOn}.
          Changed your mind? Approve it below.
        </p>
      )}
      {booking?.decision === "approved" && booking.removed && (
        <>
          <p className="booking-status">
            <span className="pill pill-neutral">Off the site</span> Approved for {booking.showsOn}, then
            taken off your events page. Put it back as it was, or approve it for a new date — that
            emails them again.
          </p>
          <div className="actions">
            <OpButton publicId={publicId} op="relist" action={action} disabled={disabled}>
              Put it back on the site
            </OpButton>
          </div>
        </>
      )}
      <ApproveForm
        publicId={publicId}
        defaultDate={booking?.eventDate && booking.eventDate >= today ? booking.eventDate : suggested}
        today={today}
        action={action}
        disabled={disabled}
        pending={pending}
        label={booking?.decision === "approved" ? "Approve for this date and email them" : "Approve and email them"}
      />
      {booking?.decision !== "declined" && (
        <div className="booking-decline">
          <OpButton publicId={publicId} op="decline" action={action} disabled={disabled}>
            Decline
          </OpButton>
        </div>
      )}
    </div>
  );
}

/**
 * Approve and Decline straight from the inbox, for a request whose date is
 * still ahead. Anything needing a different date or a start time opens the
 * request instead.
 */
export function BookingQuickActions({
  publicId,
  requestedDate,
  today,
  readOnly,
}: {
  publicId: string;
  requestedDate: string | null;
  today: string;
  readOnly: boolean;
}) {
  const [state, action, pending] = useActionState<LeadActionResult | null, FormData>(bookingAction, null);
  const canApprove = Boolean(requestedDate && requestedDate >= today);
  const disabled = pending || readOnly;

  return (
    <div className="booking-quick">
      {canApprove ? (
        <form action={action}>
          <input type="hidden" name="lead" value={publicId} />
          <input type="hidden" name="op" value="approve" />
          <input type="hidden" name="date" value={requestedDate ?? ""} />
          <button type="submit" className="small" disabled={disabled}>
            {pending ? "Working…" : "Approve"}
          </button>
        </form>
      ) : (
        <Link className="button small" href={`/dashboard/growth/leads/${publicId}`}>
          Pick a date
        </Link>
      )}
      <OpButton publicId={publicId} op="decline" action={action} disabled={disabled} className="small secondary">
        Decline
      </OpButton>
      {state && (
        <p className={state.ok ? "booking-quick-done" : "error"} role="status">
          {state.message}
        </p>
      )}
    </div>
  );
}

/**
 * The performer's uploaded logo, or a line saying it could not be shown.
 * The route answers 404 when Netlify no longer has the file or it was not an
 * image; a broken-image icon would read as a fault in the portal.
 */
export function BookingLogoPreview({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  const image = useRef<HTMLImageElement>(null);

  // An image that failed before hydration fired its error event before
  // React was listening.
  useEffect(() => {
    const img = image.current;
    if (img?.complete && img.naturalWidth === 0) setFailed(true);
  }, []);

  if (failed) {
    return <p className="booking-logo booking-logo-missing">Their logo couldn&rsquo;t be loaded.</p>;
  }
  return (
    // A plain <img>: the route streams the performer's upload after checking
    // it is a raster image, and next/image would only keep a second copy.
    // eslint-disable-next-line @next/next/no-img-element
    <img ref={image} className="booking-logo" src={src} alt={alt} onError={() => setFailed(true)} />
  );
}
