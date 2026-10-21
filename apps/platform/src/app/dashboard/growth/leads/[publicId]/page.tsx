import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { requireGrowthFeature } from "@/db/repositories/client/growth";
import { openLead } from "@/db/repositories/client/leads";
import { businessTimeZone, formatDateTime, formatDateWithYear } from "@/lib/time";
import { DeleteLeadForm, LeadArchiveForm, LeadStatusForm } from "../lead-controls";
import { RefreshOnRead } from "../refresh-on-read";
import { LeadReplyForm } from "../reply-form";
import { listLeadReplies, replyIdentity } from "@/db/repositories/client/lead-replies";
import {
  bookingCalendar,
  findBookingState,
  type BookingState,
} from "@/db/repositories/client/event-bookings";
import { isMonth, monthOf } from "@/lib/growth/booking-calendar";
import {
  BOOKING_FIELDS,
  formatEventDate,
  formatShowDate,
  isBookingForm,
  readBookingRequest,
  todayIn,
  type BookingRequest,
} from "@/lib/growth/bookings";
import { BookingCalendar } from "../booking-calendar";
import { BookingDecision, BookingLogoPreview, type BookingView } from "../booking-controls";

const TICKETS: Record<NonNullable<BookingRequest["sellingTickets"]>, string> = {
  yes: "Yes",
  no: "No",
  unsure: "Not sure yet",
};

function showsOn(state: BookingState): string | null {
  return state.eventDate ? formatShowDate(state.eventDate, state.startTime) : null;
}

/**
 * The booking half of a booking request: what they asked for, their logo,
 * and the decision. Shown above everything else on the page, because it is
 * the reason the page was opened.
 */
function BookingPanel({
  publicId,
  request,
  booking,
  canReply,
  readOnly,
}: {
  publicId: string;
  request: BookingRequest;
  booking: BookingState | null;
  canReply: boolean;
  readOnly: boolean;
}) {
  const today = todayIn(businessTimeZone());
  const view: BookingView | null = booking
    ? {
        decision: booking.decision,
        eventDate: booking.eventDate,
        startTime: booking.startTime,
        emailStatus: booking.emailStatus,
        hasLogo: booking.hasLogo,
        removed: booking.removed,
        decidedOn: formatDateWithYear(booking.decidedAt),
        showsOn: showsOn(booking),
      }
    : null;

  return (
    <section className="panel booking-panel">
      <div className="panel-head">
        <h2>Booking request</h2>
      </div>
      <div className="panel-body">
        <div className="booking-request">
          {(request.logoName || booking?.hasLogo) && (
            <BookingLogoPreview
              src={`/dashboard/growth/leads/${publicId}/logo`}
              alt={`${request.actName ?? "Their"} logo`}
            />
          )}
          <dl className="detail-grid">
            <dt>Act</dt>
            <dd>{request.actName ?? "Not given"}</dd>
            <dt>Genre</dt>
            <dd>{request.genre ?? "Not given"}</dd>
            <dt>Asked for</dt>
            <dd>{request.requestedDate ? formatEventDate(request.requestedDate) : "No date given"}</dd>
            <dt>Expected crowd</dt>
            <dd>{request.expectedAttendance ?? "Not sure yet"}</dd>
            <dt>Selling tickets</dt>
            <dd>{request.sellingTickets ? TICKETS[request.sellingTickets] : "Not given"}</dd>
            {request.links && (
              <>
                <dt>Their music</dt>
                <dd className="booking-links">{request.links}</dd>
              </>
            )}
          </dl>
        </div>
        <BookingDecision
          publicId={publicId}
          requestedDate={request.requestedDate}
          today={today}
          booking={view}
          canReply={canReply}
          readOnly={readOnly}
        />
      </div>
    </section>
  );
}

/**
 * The month the calendar opens on beside a request: the night it is booked or
 * held for, else the night they asked for — unless that has passed, when this
 * month is more use.
 */
function requestMonth(booking: BookingState | null, request: BookingRequest, today: string): string {
  const night = booking?.decision !== "declined" ? (booking?.eventDate ?? request.requestedDate) : request.requestedDate;
  return night && night >= today ? monthOf(night) : monthOf(today);
}

/** Field names the booking panel already shows. */
const BOOKING_KEYS = new Set<string>(Object.values(BOOKING_FIELDS));

/**
 * One enquiry: who, how to reach them, what they said, and where it stands.
 *
 * Opening it marks it read (see `openLead`). Contact details are links — a
 * tap to call or email is the whole point of reading this on a phone.
 *
 * Everything rendered here was typed by a stranger into a public form. React
 * escapes it; nothing here uses `dangerouslySetInnerHTML`, and the only URL
 * rendered as a link is the page URL, which the parser accepted only as
 * http(s).
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Enquiry",
  robots: { index: false, follow: false },
};

export default async function LeadPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicId: string }>;
  searchParams: Promise<{ month?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.organizationId) notFound();

  const { publicId } = await params;
  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  // Not in their plan: the Growth tab explains how to get it, and says how
  // many enquiries are already waiting — they are kept either way.
  if (!(await requireGrowthFeature(db, ctx, "leads"))) redirect("/dashboard/growth?locked=leads#leads");

  let lead;
  try {
    lead = await openLead(db, ctx, publicId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const isBooking = isBookingForm(lead.formName);
  const [replies, identity, booking] = await Promise.all([
    listLeadReplies(db, ctx, publicId),
    replyIdentity(db, ctx),
    isBooking ? findBookingState(db, ctx, publicId) : Promise.resolve(null),
  ]);

  // The rest of what they filled in. Name, email, phone and message are
  // already shown above as the heading, the buttons and the message itself;
  // listing them again pushes the one field that is new — "Which service?" —
  // below the fold on a phone. A booking request's own fields are in the
  // booking panel.
  const shown = new Set([lead.name, lead.email, lead.phone, lead.message].filter(Boolean));
  const otherFields = lead.fields.filter(
    (field) => !shown.has(field.value) && !(isBooking && field.key && BOOKING_KEYS.has(field.key)),
  );

  const telHref = lead.phone ? `tel:${lead.phone.replace(/[^\d+]/g, "")}` : null;
  const request = isBooking ? readBookingRequest(lead.fields) : null;
  const who = lead.name ?? lead.email ?? lead.phone;

  // Beside a booking request, the venue's calendar for that night's month.
  const today = todayIn(businessTimeZone());
  const { month: monthParam } = await searchParams;
  const month = request && (isMonth(monthParam) ? monthParam : requestMonth(booking, request, today));
  const calendar = month ? await bookingCalendar(db, ctx, month) : null;
  const focusDate =
    booking && booking.decision !== "declined" ? booking.eventDate : (request?.requestedDate ?? null);

  const content = (
    <div className="lead-main">
      {request && (
        <BookingPanel
          publicId={lead.publicId}
          request={request}
          booking={booking}
          canReply={Boolean(lead.email)}
          readOnly={ctx.impersonating}
        />
      )}

      <section className="panel">
        <div className="panel-body">
          {(lead.email || telHref) && (
            <div className="lead-contact">
              {telHref && (
                <a className="button" href={telHref}>
                  Call {lead.phone}
                </a>
              )}
              {lead.email && (
                <a className={`button${telHref ? " secondary" : ""}`} href={`mailto:${lead.email}`}>
                  Email {lead.email}
                </a>
              )}
            </div>
          )}

          {lead.message && <p className="lead-message">{lead.message}</p>}

          {otherFields.length > 0 && (
            <dl className="detail-grid lead-fields">
              {otherFields.map((field, index) => (
                <div key={index} style={{ display: "contents" }}>
                  <dt>{field.label}</dt>
                  <dd>{field.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {lead.pageUrl && (
            <p className="panel-note">
              Sent from{" "}
              <a href={lead.pageUrl} target="_blank" rel="noopener noreferrer nofollow">
                {lead.pageUrl}
              </a>
            </p>
          )}
        </div>
      </section>

      <section className="panel" id="reply">
        <div className="panel-head">
          <h2>Reply</h2>
        </div>
        <div className="panel-body">
          {replies.length > 0 && (
            <ol className="lead-thread">
              {replies.map((reply) => (
                <li key={reply.publicId}>
                  <p className="lead-thread-meta">
                    {reply.sentByName ?? "You"} · {formatDateTime(reply.createdAt)}
                    {reply.status === "failed" && (
                      <span className="pill pill-danger">Not delivered</span>
                    )}
                    {reply.status === "not_sent" && (
                      <span className="pill pill-warning">Not emailed</span>
                    )}
                  </p>
                  <p className="lead-thread-body">{reply.body}</p>
                </li>
              ))}
            </ol>
          )}

          {lead.email ? (
            <LeadReplyForm
              publicId={lead.publicId}
              customerEmail={lead.email}
              businessName={identity.businessName}
              replyTo={identity.replyTo}
              readOnly={ctx.impersonating}
            />
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              They didn&rsquo;t leave an email address
              {telHref ? ", so the way to answer is to call them." : "."}
            </p>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Where it stands</h2>
        </div>
        <div className="panel-body">
          <LeadStatusForm publicId={lead.publicId} current={lead.status} readOnly={ctx.impersonating} />
          {lead.status === "archived" && (
            <p className="notice">
              This was archived before the portal kept what you marked it, so we
              don&rsquo;t know where it stood. If you remember, pick it above.
            </p>
          )}
          <p className="panel-note">
            Only you set this. Marking enquiries won is how your monthly report can say
            how much work your website brought in.
          </p>
          <LeadArchiveForm publicId={lead.publicId} archived={lead.archived} readOnly={ctx.impersonating} />
        </div>
      </section>

      <DeleteLeadForm publicId={lead.publicId} readOnly={ctx.impersonating} />
    </div>
  );

  return (
    <main className="shell">
      <RefreshOnRead wasUnread={lead.unread} />
      <p className="lead-back">
        <Link href="/dashboard/growth/leads">← All leads</Link>
      </p>

      <div className="masthead">
        <h1>{request?.actName ?? who ?? "Enquiry"}</h1>
        <span>
          {request?.actName && who ? `From ${who} · ` : ""}
          {formatDateTime(lead.receivedAt)} · {lead.siteName}
        </span>
      </div>

      {month && calendar ? (
        <div className="leads-layout">
          {content}
          <BookingCalendar
            month={month}
            entries={calendar}
            today={today}
            focusDate={focusDate}
            hrefFor={(m) => `/dashboard/growth/leads/${lead.publicId}?month=${m}`}
          />
        </div>
      ) : (
        content
      )}
    </main>
  );
}
