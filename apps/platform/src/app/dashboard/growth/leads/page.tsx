import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { requireGrowthFeature } from "@/db/repositories/client/growth";
import { isLeadView, listLeads, type LeadSummary, type LeadView } from "@/db/repositories/client/leads";
import { bookingStatesFor, type BookingState } from "@/db/repositories/client/event-bookings";
import {
  decisionNotice,
  formatEventDate,
  isBookingForm,
  readBookingRequest,
  todayIn,
} from "@/lib/growth/bookings";
import { businessTimeZone, formatDateTime } from "@/lib/time";
import { BookingQuickActions } from "./booking-controls";
import { LeadStatusPill } from "./status-pill";

/** One line for a booking request in the list: who, what, and when they asked for. */
function bookingPreview(lead: LeadSummary): string {
  const request = readBookingRequest(lead.fields);
  return [
    request.actName,
    request.genre,
    request.requestedDate ? `wants ${formatEventDate(request.requestedDate)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function BookingPill({ state }: { state: BookingState | undefined }) {
  if (!state) return <span className="pill pill-accent">Booking request</span>;
  if (state.decision === "declined") return <span className="pill pill-neutral">Declined</span>;
  if (state.removed) return <span className="pill pill-neutral">Off the site</span>;
  return <span className="pill pill-success">Booked</span>;
}

/**
 * The leads inbox: every message from the client's contact form, newest first.
 *
 * The view lives in the URL, like the media library's filters, so "show me
 * the ones I won" is a link a client can bookmark or send us.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Leads",
  robots: { index: false, follow: false },
};

const VIEWS: { value: LeadView; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All" },
];

const EMPTY: Record<LeadView, string> = {
  open: "No open enquiries. When someone fills in the contact form on your website, it appears here, and you still get the usual email about it.",
  won: "Nothing marked as won yet. Open an enquiry and mark it won when it turns into a job.",
  lost: "Nothing marked as lost.",
  archived: "Nothing archived.",
  all: "No enquiries yet. When someone fills in the contact form on your website, it appears here, and you still get the usual email about it.",
  new: "Nothing new.",
  contacted: "Nothing marked as contacted.",
};

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; page?: string; deleted?: string; decided?: string }>;
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

  const href = (v: LeadView, p = 1) =>
    `/dashboard/growth/leads${v === "open" && p === 1 ? "" : `?view=${v}${p > 1 ? `&page=${p}` : ""}`}`;

  return (
    <main className="shell">
      <div className="masthead">
        <h1>Leads</h1>
        <span>From your website&rsquo;s contact form</span>
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

      <section className="panel">
        <div className="panel-head">
          <h2>{VIEWS.find((v) => v.value === view)?.label ?? "Enquiries"}</h2>
          <nav className="segmented lead-views" aria-label="Which enquiries">
            {VIEWS.map((v) => (
              <Link
                key={v.value}
                href={href(v.value)}
                aria-current={v.value === view ? "true" : undefined}
              >
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
              const preview = isBooking ? bookingPreview(lead) || lead.preview : lead.preview;
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
                  {isBooking && !booking && (
                    <BookingQuickActions
                      publicId={lead.publicId}
                      requestedDate={readBookingRequest(lead.fields).requestedDate}
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
      </section>
    </main>
  );
}
