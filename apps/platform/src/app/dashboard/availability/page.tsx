import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import {
  bookingAccess,
  bookingPageFor,
  getAvailability,
  previewSlots,
  type SlotPreview,
} from "@/db/repositories/client/availability";
import { listAppointments, type AppointmentView } from "@/db/repositories/client/availability-bookings";
import { calendarStatus, type CalendarStatus } from "@/db/repositories/client/availability-calendar";
import { bookingsByDate } from "@/lib/availability/calendar";
import { formatDay, formatDuration, formatRange, formatSlotTime, timeZoneLabel } from "@/lib/availability/format";
import { BUFFERS, HORIZONS, NOTICES, SLOT_LENGTHS, TIME_ZONES } from "@/lib/availability/rules";
import { bookableWindow, type Slot } from "@/lib/availability/slots";
import { dateInZone } from "@/lib/availability/time";
import { AvailabilityCalendar } from "./availability-calendar";
import { PendingBookings, UpcomingBookings, type BookingRow } from "./bookings";
import { DisconnectCalendar } from "./calendar-controls";
import { DaysOff } from "./days-off";
import { HoursEditor } from "./hours-editor";
import { RulesForm, type RuleOptions } from "./rules-form";
import "./availability.css";

/**
 * Set your availability: the times customers can book on the client's
 * website, and the bookings that came from it.
 *
 * Opened by `clients.booking_enabled` (or the agency's own account, to try
 * it). The tab in the nav is not the gate; this page checks for itself.
 *
 * Requests to answer come first when there are any — that is the daily use.
 * Then the month calendar, the main way to set times: press a day to open or
 * close it. Below it, what shapes the times (weekly hours, rules, days off)
 * on the left, and what comes out (the website's next open times, and the
 * Google Calendar they are checked against) on the right; stacked in that
 * order on a phone.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Availability",
  robots: { index: false, follow: false },
};

const OUTCOMES: Record<string, { tone: "success" | "info" | "warning"; text: string }> = {
  connected: { tone: "success", text: "Google Calendar is connected. Your website now skips times you're busy." },
  connected_unread: {
    tone: "info",
    text: "Google Calendar is connected, but couldn't be read just now. Your website offers no times until it can be — reload in a minute.",
  },
  denied: { tone: "info", text: "Nothing was connected — you stopped at the Google sign-in." },
  expired: { tone: "warning", text: "That sign-in took too long or was opened in another browser. Try again." },
  failed: { tone: "warning", text: "Google Calendar couldn't be connected. Try again, and let us know if it keeps happening." },
  not_configured: { tone: "info", text: "Connecting Google Calendar isn't switched on yet. We'll let you know when it is." },
  not_allowed: { tone: "info", text: "Google Calendar is connected by the client themselves, not while viewing as them." },
};

const PREVIEW_DAYS = 5;
const PREVIEW_TIMES_PER_DAY = 8;

function ruleOptions(): RuleOptions {
  const minutes = (values: readonly number[]) => values.map((value) => ({ value, label: formatDuration(value) }));
  return {
    timeZones: TIME_ZONES.map((z) => ({ value: z.value, label: `${z.label} (${z.value})` })),
    slotLengths: minutes(SLOT_LENGTHS),
    buffers: minutes(BUFFERS),
    notices: minutes(NOTICES),
    horizons: HORIZONS.map((days) => ({ value: days, label: formatDuration(days * 1440) })),
  };
}

function bookingRow(view: AppointmentView, now: Date): BookingRow {
  const tz = view.timeZone;
  const asked = view.status === "pending";
  const warning =
    view.customerEmailStatus === "failed"
      ? `The email to ${view.customerName} didn't go through.`
      : view.status === "confirmed" && view.customerEmailStatus === "not_sent"
        ? `${view.customerName} wasn't emailed a confirmation.`
        : null;
  const created = view.createdAt;
  const sameDay = dateInZone(created, tz) === dateInZone(now, tz);
  return {
    publicId: view.publicId,
    day: formatDay(dateInZone(view.startsAt, tz)),
    time: `${formatSlotTime(view.startsAt, tz)} – ${formatSlotTime(view.endsAt, tz)}`,
    name: view.customerName,
    email: view.customerEmail,
    phone: view.customerPhone,
    note: view.note,
    meta: `${asked ? "Asked" : "Booked"} ${sameDay ? "today" : formatDay(dateInZone(created, tz))}, ${formatSlotTime(created, tz)}`,
    emailWarning: warning,
  };
}

export default async function AvailabilityPage({ searchParams }: { searchParams: Promise<{ connect?: string }> }) {
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
  const access = await bookingAccess(db, ctx);
  if (!access.allowed) return <NotSwitchedOn />;

  const now = new Date();
  const [view, preview, lists, calendar, bookingPage, { connect }] = await Promise.all([
    getAvailability(db, ctx, now),
    previewSlots(db, ctx, { now }),
    listAppointments(db, ctx, now),
    calendarStatus(db, ctx),
    bookingPageFor(db, ctx),
    searchParams,
  ]);
  const readOnly = ctx.impersonating;
  const tz = view.rules.timeZone;
  const setUp = preview.open;

  const [provider, outcomeKey] = (connect ?? "").split(":");
  const outcome = provider === "google_calendar" && outcomeKey ? OUTCOMES[outcomeKey] : undefined;

  const calendarBookings = bookingsByDate([
    ...lists.pending.map((b) => ({ ...b, status: "pending" as const })),
    ...lists.upcoming.map((b) => ({ ...b, status: "confirmed" as const })),
  ]);

  // Where a client has asked to approve each request, this is the section
  // they come to answer. With something waiting it leads the page; otherwise
  // it follows the calendar as a short "nothing waiting".
  const waitingPanel =
    view.rules.requiresApproval || lists.pending.length > 0 ? (
      <section
        className={`panel${lists.pending.length > 0 ? " avail-waiting" : ""}`}
        aria-labelledby="avail-pending"
      >
        <div className="panel-head">
          <h2 id="avail-pending">Waiting for your answer</h2>
          {lists.pending.length > 0 && <span className="pill pill-warning">{lists.pending.length} to answer</span>}
        </div>
        <div className="panel-body">
          {lists.pending.length > 0 && (
            <p className="avail-waiting-lede">
              Someone picked these times on your website. <strong>Accept</strong> confirms the time and emails them.{" "}
              <strong>Decline</strong> opens the time again and emails them too.
            </p>
          )}
          <PendingBookings rows={lists.pending.map((b) => bookingRow(b, now))} readOnly={readOnly} />
        </div>
      </section>
    ) : null;

  return (
    <main className="shell avail">
      <div className="masthead">
        <h1>Availability</h1>
        <span>When customers can book you on your website</span>
      </div>

      {outcome && (
        <p className={`notice notice-${outcome.tone}`} role="status">
          <strong>Google Calendar:</strong> {outcome.text}
        </p>
      )}
      {!access.bookingEnabled && (
        <p className="notice notice-info">
          Online booking is off for this account&rsquo;s website, so it takes no bookings. The page is open because this is
          your own account.
        </p>
      )}
      {!setUp && (
        <p className="notice notice-info">
          Start by setting when you&rsquo;re open: press a day on the calendar, or fill in your weekly hours below. Until
          there are some, your website&rsquo;s booking page offers no times.
        </p>
      )}

      {waitingPanel && lists.pending.length > 0 && waitingPanel}

      <section className="panel" aria-labelledby="avail-calendar-title">
        <div className="panel-head">
          <h2 id="avail-calendar-title">Your calendar</h2>
          <span className="panel-sub">{timeZoneLabel(tz, now)}</span>
        </div>
        <div className="panel-body">
          <p className="avail-lede">
            Press a day to set when you&rsquo;re open. {view.rules.requiresApproval ? "When someone asks for a time, you accept or decline it." : "Open times are booked straight away."}
          </p>
          <AvailabilityCalendar
            weekly={view.weekly}
            overrides={view.overrides.map((o) => ({ publicId: o.publicId, date: o.date, ranges: o.ranges }))}
            bookings={calendarBookings}
            today={view.today}
            lastBookable={bookableWindow(view.rules, now).last}
            readOnly={readOnly}
          />
        </div>
      </section>

      {waitingPanel && lists.pending.length === 0 && waitingPanel}

      {(setUp || lists.upcoming.length > 0) && (
        <section className="panel" aria-labelledby="avail-upcoming">
          <div className="panel-head">
            <h2 id="avail-upcoming">Coming up</h2>
            <span className="panel-sub">
              {lists.upcoming.length === 0 ? "Nothing booked yet" : `${lists.upcoming.length} confirmed`}
            </span>
          </div>
          <div className="panel-body">
            <UpcomingBookings rows={lists.upcoming.map((b) => bookingRow(b, now))} readOnly={readOnly} />
            {lists.recent.length > 0 && (
              <details className="avail-recent">
                <summary>Declined and cancelled ({lists.recent.length})</summary>
                <ul>
                  {lists.recent.map((b) => (
                    <li key={b.publicId}>
                      <span>
                        {formatDay(dateInZone(b.startsAt, b.timeZone))}, {formatSlotTime(b.startsAt, b.timeZone)}
                      </span>
                      <span>{b.customerName}</span>
                      <span className="pill pill-neutral">{b.status === "declined" ? "Declined" : "Cancelled"}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </section>
      )}

      <div className="avail-layout">
        <div className="avail-main">
          <section className="panel" aria-labelledby="avail-hours">
            <div className="panel-head">
              <h2 id="avail-hours">Your weekly hours</h2>
              <span className="panel-sub">{timeZoneLabel(tz, now)}</span>
            </div>
            <div className="panel-body">
              <p className="avail-lede">The times you take bookings each week. Add a second block for a lunch break.</p>
              <HoursEditor initial={view.weekly} readOnly={readOnly} />
            </div>
          </section>

          <section className="panel" aria-labelledby="avail-rules">
            <div className="panel-head">
              <h2 id="avail-rules">How booking works</h2>
            </div>
            <div className="panel-body">
              <RulesForm
                rules={view.rules}
                options={ruleOptions()}
                saved={view.rulesSaved}
                readOnly={readOnly}
                labels={{
                  slot: formatDuration(view.rules.slotMinutes),
                  buffer: formatDuration(view.rules.bufferMinutes),
                  notice: formatDuration(view.rules.minNoticeMinutes),
                  horizon: formatDuration(view.rules.horizonDays * 1440),
                }}
              />
            </div>
          </section>

          <section className="panel" aria-labelledby="avail-days">
            <div className="panel-head">
              <h2 id="avail-days">Days off and different hours</h2>
            </div>
            <div className="panel-body">
              <DaysOff
                today={view.today}
                readOnly={readOnly}
                days={view.overrides.map((o) => ({
                  publicId: o.publicId,
                  dayLabel: formatDay(o.date),
                  closed: o.ranges.length === 0,
                  hoursLabel: o.ranges.length === 0 ? "Closed" : o.ranges.map(formatRange).join(", "),
                }))}
              />
            </div>
          </section>
        </div>

        <div className="avail-side">
          <section className="panel" aria-labelledby="avail-preview">
            <div className="panel-head">
              <h2 id="avail-preview">What your website shows</h2>
            </div>
            <div className="panel-body">
              <Preview preview={preview} now={now} bookingPage={bookingPage} />
            </div>
          </section>

          <section className="panel" aria-labelledby="avail-calendar">
            <div className="panel-head">
              <h2 id="avail-calendar">Google Calendar</h2>
              <CalendarPill calendar={calendar} />
            </div>
            <div className="panel-body">
              <CalendarCard calendar={calendar} readOnly={readOnly} viewingAs={Boolean(user.viewingAs)} timeZone={tz} />
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

function NotSwitchedOn() {
  return (
    <main className="shell">
      <div className="masthead">
        <h1>Availability</h1>
        <span>When customers can book you on your website</span>
      </div>
      <section className="panel">
        <div className="panel-body">
          <p style={{ marginTop: 0 }}>Online booking isn&rsquo;t switched on for your website.</p>
          <p className="muted" style={{ marginBottom: 0 }}>
            If you&rsquo;d like customers to pick a time and book you from your site, <Link href="/dashboard/requests">ask us</Link>{" "}
            and we&rsquo;ll set it up.
          </p>
        </div>
      </section>
    </main>
  );
}

function groupDays(slots: Slot[]): Array<{ date: string; slots: Slot[] }> {
  const days: Array<{ date: string; slots: Slot[] }> = [];
  for (const slot of slots) {
    const last = days.at(-1);
    if (last && last.date === slot.date) last.slots.push(slot);
    else days.push({ date: slot.date, slots: [slot] });
  }
  return days;
}

function Preview({
  preview,
  now,
  bookingPage,
}: {
  preview: SlotPreview;
  now: Date;
  bookingPage: { hasSite: boolean; url: string | null };
}) {
  const { rules } = preview;
  const where = bookingPage.url ? (
    <p className="avail-bookpage">
      Customers book at{" "}
      <a href={bookingPage.url} target="_blank" rel="noreferrer">
        {bookingPage.url.replace(/^https?:\/\//, "")}
      </a>
    </p>
  ) : (
    <p className="avail-bookpage muted">
      {bookingPage.hasSite
        ? "Your site's address isn't set up yet, so it can't take bookings. We'll sort that when it goes live."
        : "There's no website on your account yet. Booking appears on it once there is."}
    </p>
  );

  if (preview.calendar.kind === "failed") {
    return (
      <>
        <p className="notice notice-warning" style={{ marginTop: 0 }}>
          {preview.calendar.reason === "needs_reconnect"
            ? "Google Calendar needs connecting again."
            : preview.calendar.reason === "not_configured"
              ? "Google Calendar is connected but can't be read here yet."
              : "Google Calendar couldn't be read just now."}{" "}
          Until it can, your website says online booking is unavailable rather than offer times that might clash.
        </p>
        {where}
      </>
    );
  }

  const days = groupDays(preview.slots ?? []);
  return (
    <>
      {!preview.open ? (
        <p className="muted avail-empty-line">No times yet. Set your weekly hours and they appear here.</p>
      ) : days.length === 0 ? (
        <p className="muted avail-empty-line">No open times in the next {formatDuration(rules.horizonDays * 1440)}.</p>
      ) : (
        <ul className="avail-preview">
          {days.slice(0, PREVIEW_DAYS).map((day) => (
            <li key={day.date}>
              <span className="avail-preview-day">
                {day.date === dateInZone(now, rules.timeZone) ? "Today" : formatDay(day.date)}
              </span>
              <span className="avail-preview-times">
                {day.slots.slice(0, PREVIEW_TIMES_PER_DAY).map((slot) => (
                  <span key={slot.start.toISOString()} className="avail-chip">
                    {formatSlotTime(slot.start, rules.timeZone)}
                  </span>
                ))}
                {day.slots.length > PREVIEW_TIMES_PER_DAY && (
                  <span className="avail-chip avail-chip--more">+{day.slots.length - PREVIEW_TIMES_PER_DAY} more</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="panel-note">
        Appointments are {formatDuration(rules.slotMinutes)}, in {timeZoneLabel(rules.timeZone, now)}.{" "}
        {rules.minNoticeMinutes > 0 ? `Nothing sooner than ${formatDuration(rules.minNoticeMinutes)} from now; up` : "Up"} to{" "}
        {formatDuration(rules.horizonDays * 1440)} ahead.{" "}
        {rules.requiresApproval ? "Each booking waits for your approval." : "Bookings are confirmed straight away."}
        {preview.calendar.kind === "ok" ? " Busy times in your Google Calendar are left out." : ""}
      </p>
      {where}
    </>
  );
}

function CalendarPill({ calendar }: { calendar: CalendarStatus }) {
  if (calendar.connection?.status === "needs_reconnect") return <span className="pill pill-warning">Needs reconnecting</span>;
  if (calendar.connection) return <span className="pill pill-success">Connected</span>;
  if (!calendar.configured) return <span className="pill pill-neutral">Not switched on</span>;
  return <span className="pill pill-neutral">Not connected</span>;
}

function CalendarCard({
  calendar,
  readOnly,
  viewingAs,
  timeZone,
}: {
  calendar: CalendarStatus;
  readOnly: boolean;
  viewingAs: boolean;
  timeZone: string;
}) {
  const connectButton = (label: string) =>
    viewingAs || readOnly ? (
      <p className="muted" style={{ marginBottom: 0 }}>
        The client connects their own calendar; it can&rsquo;t be done while viewing as them.
      </p>
    ) : (
      <a className="button" href="/api/connections/google_calendar/start">
        {label}
      </a>
    );

  const privacy = (
    <p className="field-hint avail-calendar-privacy">
      Busy or free only. We can&rsquo;t see what your events are, who&rsquo;s in them or where, and we can&rsquo;t add,
      change or delete anything in your calendar.
    </p>
  );

  if (calendar.connection) {
    const { connection } = calendar;
    const failedSince =
      calendar.lastError && calendar.lastErrorAt && (!calendar.lastCheckedAt || calendar.lastErrorAt > calendar.lastCheckedAt);
    return (
      <>
        <p style={{ marginTop: 0 }}>
          Reading busy times from <strong>{connection.email ?? "your Google account"}</strong>&rsquo;s main calendar.
        </p>
        {connection.status === "needs_reconnect" ? (
          <>
            <p className="notice notice-warning">
              Google stopped letting us read it — usually a changed password or access removed in your Google account.
              Connect it again to carry on.
            </p>
            {connectButton("Reconnect Google Calendar")}
          </>
        ) : failedSince ? (
          <p className="notice notice-warning">The last read failed. We&rsquo;ll try again the next time someone opens your booking page.</p>
        ) : (
          <p className="muted">
            {calendar.lastCheckedAt
              ? `Last checked at ${formatSlotTime(calendar.lastCheckedAt, timeZone)}, and again every few minutes while people are booking.`
              : "Checked every few minutes while people are booking."}
          </p>
        )}
        {privacy}
        <DisconnectCalendar readOnly={readOnly || viewingAs} />
      </>
    );
  }

  if (!calendar.configured) {
    return (
      <>
        <p style={{ marginTop: 0 }}>
          Connect your Google Calendar and your website won&rsquo;t offer times you&rsquo;re already busy.
        </p>
        <p className="muted" style={{ marginBottom: 0 }}>
          Not switched on here yet. Your weekly hours work without it; they just don&rsquo;t know about your calendar.
        </p>
      </>
    );
  }

  return (
    <>
      <p style={{ marginTop: 0 }}>
        Connect your Google Calendar and your website won&rsquo;t offer times you&rsquo;re already busy.
      </p>
      {privacy}
      {connectButton("Connect Google Calendar")}
    </>
  );
}
