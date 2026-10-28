import Link from "next/link";
import { BackToGrowth } from "@/components/back-link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { requireGrowthFeature } from "@/db/repositories/client/growth";
import {
  INBOX_SIZE,
  isLeadView,
  listLeads,
  type LeadSummary,
  type LeadView,
} from "@/db/repositories/client/leads";
import {
  bookingCalendar,
  bookingStatesFor,
  takesBookings,
  type BookingState,
} from "@/db/repositories/client/event-bookings";
import { isMonth, monthOf } from "@/lib/growth/booking-calendar";
import {
  decisionNotice,
  formatEventDate,
  formatShowDate,
  isBookingForm,
  readBookingRequest,
  todayIn,
} from "@/lib/growth/bookings";
import { businessTimeZone, formatDateTime } from "@/lib/time";
import { BookingCalendar } from "./booking-calendar";
import { BookingQuickActions } from "./booking-controls";
import { LeadStatusPill } from "./status-pill";

/**
 * One line for a booking request in the list: who, what, and the night — the
 * one booked or held once there is one, otherwise the one they asked for.
 */
function bookingPreview(lead: LeadSummary, state: BookingState | undefined): string {
  const request = readBookingRequest(lead.fields);
  const scheduled = state && state.decision !== "declined" && !state.removed && state.eventDate;
  const night = scheduled
    ? `${state.decision === "held" ? "held for" : "booked for"} ${formatShowDate(scheduled, state.startTime)}`
    : request.requestedDate
      ? `wants ${formatEventDate(request.requestedDate)}`
      : null;
  return [request.actName, request.genre, night].filter(Boolean).join(" · ");
}

function BookingPill({ state }: { state: BookingState | undefined }) {
  if (!state) return <span className="pill pill-accent">Booking request</span>;
  if (state.decision === "held") return <span className="pill pill-warning">Held</span>;
  if (state.decision === "declined") return <span className="pill pill-neutral">Declined</span>;
  if (state.removed) return <span className="pill pill-neutral">Off the site</span>;
  return <span className="pill pill-success">Booked</span>;
}

/**
 * The leads inbox: the newest enquiries from the client's website, and the
 * older ones under Archived. A venue that takes bookings also gets its
 * calendar beside the list.
 *
 * The view and the calendar's month live in the URL, like the media library's
 * filters, so either is a link a client can bookmark or send us.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Leads",
  robots: { index: false, follow: false },
};

const VIEWS: { value: LeadView; label: string }[] = [
  { value: "open", label: "Inbox" },
  { value: "archived", label: "Archived" },
];

const EMPTY: Record<LeadView, string> = {
  open: "No enquiries yet. When someone fills in a form on your website, it appears here, and you still get the usual email about it.",
  archived: `Nothing archived. Your inbox keeps the newest ${INBOX_SIZE}; older ones move here on their own.`,
};

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; page?: string; deleted?: string; decided?: string; month?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.organizationId) {
    return (
      <main className="shell">
        <p className="notice">
          Your account is not linked to an organization yet. Please contact us.
        </p>
      </main>
    );
  }

  const params = await searchParams;
  const view: LeadView = isLeadView(params.view) ? params.view : "open";
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  // Not in their plan: the Growth tab explains how to get it, and says how
  // many enquiries are already waiting — they are kept either way.
  if (!(await requireGrowthFeature(db, ctx, "leads"))) redirect("/dashboard/growth?locked=leads#leads");
  const { leads, hasMore } = await listLeads(db, ctx, { view, page });
  const bookingIds = leads.filter((lead) => isBookingForm(lead.formName)).map((lead) => lead.publicId);
  const bookings = await bookingStatesFor(db, ctx, bookingIds);
  const today = todayIn(businessTimeZone());
  // Set by a quick Approve or Decline. Looked up in this client's own
  // decisions, so a hand-edited id shows nothing rather than someone else's.
  const decidedId = typeof params.decided === "string" && params.decided.length <= 64 ? params.decided : null;
  const decided = decidedId ? (await bookingStatesFor(db, ctx, [decidedId])).get(decidedId) : undefined;

  const month = isMonth(params.month) ? params.month : monthOf(today);
  const calendar = (await takesBookings(db, ctx)) ? await bookingCalendar(db, ctx, month) : null;

  const href = (v: LeadView, p = 1, m = month) => {
    const query = new URLSearchParams();
    if (v !== "open") query.set("view", v);
    if (p > 1) query.set("page", String(p));
    if (m !== monthOf(today)) query.set("month", m);
    const qs = query.toString();
    return `/dashboard/growth/leads${qs ? `?${qs}` : ""}`;
  };

  const list = (
    <section className="panel">
      <div className="panel-head">
        <h2>{VIEWS.find((v) => v.value === view)?.label ?? "Enquiries"}</h2>
        <nav className="segmented lead-views" aria-label="Which enquiries">
          {VIEWS.map((v) => (
            <Link key={v.value} href={href(v.value)} aria-current={v.value === view ? "true" : undefined}>
              {v.label}
            </Link>
          ))}
        </nav>
      </div>

      {leads.length === 0 ? (
        <div className="empty">
          <p>{EMPTY[view]}</p>
        </div>
      ) : (
        <ul className="lead-list">
          {leads.map((lead) => {
            const isBooking = isBookingForm(lead.formName);
            const booking = bookings.get(lead.publicId);
            const preview = isBooking ? bookingPreview(lead, booking) || lead.preview : lead.preview;
            return (
              <li key={lead.publicId}>
                <Link
                  className={`lead-row${lead.unread ? " lead-unread" : ""}`}
                  href={`/dashboard/growth/leads/${lead.publicId}`}
                >
                  <span className="lead-row-head">
                    <span className="lead-row-name">
                      {lead.unread && <span className="sr-only">Unread: </span>}
                      {lead.name ?? lead.email ?? lead.phone ?? "Someone"}
                    </span>
                    <span className="lead-row-when">{formatDateTime(lead.receivedAt)}</span>
                  </span>
                  {preview && <span className="lead-row-preview">{preview}</span>}
                  <span className="lead-row-meta">
                    {lead.unread && <span className="pill pill-accent">New</span>}
                    {isBooking ? (
                      <BookingPill state={booking} />
                    ) : (
                      !lead.unread && <LeadStatusPill status={lead.status} />
                    )}
                    {[lead.phone, lead.email].filter(Boolean).join(" · ")}
                  </span>
                </Link>
                {isBooking && (!booking || booking.decision === "held") && (
                  <BookingQuickActions
                    publicId={lead.publicId}
                    requestedDate={readBookingRequest(lead.fields).requestedDate}
                    held={booking?.eventDate ? { date: booking.eventDate, time: booking.startTime } : null}
                    today={today}
                    view={view}
                    readOnly={ctx.impersonating}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {(page > 1 || hasMore) && (
        <div className="panel-body lead-pager">
          {page > 1 ? <Link href={href(view, page - 1)}>← Newer</Link> : <span />}
          {hasMore && <Link href={href(view, page + 1)}>Older →</Link>}
        </div>
      )}

      {view === "open" && leads.length > 0 && (
        <p className="panel-note lead-inbox-note">
          Your inbox keeps the newest {INBOX_SIZE}. Older enquiries move to{" "}
          <Link href={href("archived")}>Archived</Link> on their own, still marked as you left them.
        </p>
      )}
    </section>
  );

  return (
    <main className="shell">
      <BackToGrowth />
      <div className="masthead">
        <h1>Leads</h1>
        <span>From your website&rsquo;s forms</span>
      </div>

      {params.deleted === "1" && (
        <p className="notice notice-success">
          Deleted. Netlify, which receives your form, still keeps its own copy.
        </p>
      )}

      {decided && decidedId && (
        <p className={`notice ${decided.emailStatus === "failed" ? "notice-warning" : "notice-success"}`} role="status">
          {decisionNotice(decided)}{" "}
          <Link href={`/dashboard/growth/leads/${decidedId}`}>Open the request</Link>
        </p>
      )}

      {calendar ? (
        <div className="leads-layout">
          {list}
          <BookingCalendar
            month={month}
            entries={calendar}
            today={today}
            hrefFor={(m) => href(view, page, m)}
          />
        </div>
      ) : (
        list
      )}
    </main>
  );
}
