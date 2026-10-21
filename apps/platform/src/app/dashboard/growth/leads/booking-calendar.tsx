import Link from "next/link";
import type { CalendarEntry, CalendarKind } from "@/db/repositories/client/event-bookings";
import { formatMonth, monthWeeks, shiftMonth } from "@/lib/growth/booking-calendar";
import { formatEventDate, formatStartTime } from "@/lib/growth/bookings";

/**
 * A venue's month at a glance, beside the inbox and each booking request:
 * which nights are booked, which are held while a time is agreed, and which a
 * band has asked for. The list under the grid is the same month in words, and
 * each line opens its request.
 *
 * Rendered on the server; the month is in the URL, so the arrows are links.
 */

const KIND_LABEL: Record<CalendarKind, string> = {
  booked: "Booked",
  held: "Held",
  requested: "Asked for",
};

const WEEKDAYS: [string, string][] = [
  ["S", "Sunday"],
  ["M", "Monday"],
  ["T", "Tuesday"],
  ["W", "Wednesday"],
  ["T", "Thursday"],
  ["F", "Friday"],
  ["S", "Saturday"],
];

/** `2026-11-13` → `Fri 13`. */
function shortDay(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  return `${weekday} ${d}`;
}

function DayCell({
  date,
  entries,
  today,
  focusDate,
}: {
  date: string;
  entries: CalendarEntry[];
  today: string;
  focusDate: string | null;
}) {
  // Entries arrive sorted booked, held, asked for — the first sets the look.
  const top = entries[0]?.kind;
  const className = [
    "cal-day",
    top ? `cal-${top}` : null,
    date === today ? "cal-today" : null,
    date === focusDate ? "cal-focus" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <td className={className}>
      <span className="cal-num">{Number(date.slice(8))}</span>
      {entries.length > 1 && (
        <span className="cal-count" aria-hidden="true">
          {entries.length}
        </span>
      )}
      {entries.length > 0 && (
        <span className="sr-only">
          {`: ${entries.map((e) => `${e.actName}, ${KIND_LABEL[e.kind].toLowerCase()}`).join("; ")}`}
        </span>
      )}
    </td>
  );
}

function EntryLine({ entry }: { entry: CalendarEntry }) {
  const body = (
    <>
      <span className="cal-list-date">{shortDay(entry.date)}</span>
      <span className="cal-list-act">
        {entry.actName}
        {entry.startTime ? ` · ${formatStartTime(entry.startTime)}` : ""}
      </span>
      <span className={`cal-tag cal-tag-${entry.kind}`}>{KIND_LABEL[entry.kind]}</span>
    </>
  );
  return (
    <li>
      {entry.leadPublicId ? (
        <Link href={`/dashboard/growth/leads/${entry.leadPublicId}`} title={formatEventDate(entry.date)}>
          {body}
        </Link>
      ) : (
        <span title={formatEventDate(entry.date)}>{body}</span>
      )}
    </li>
  );
}

export function BookingCalendar({
  month,
  entries,
  today,
  focusDate = null,
  hrefFor,
}: {
  month: string;
  entries: CalendarEntry[];
  today: string;
  /** The night the open request is about, ringed. */
  focusDate?: string | null;
  /** The page's own URL showing another month. */
  hrefFor: (month: string) => string;
}) {
  const byDate = new Map<string, CalendarEntry[]>();
  for (const entry of entries) byDate.set(entry.date, [...(byDate.get(entry.date) ?? []), entry]);
  const name = formatMonth(month);
  const prev = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);

  return (
    <aside className="panel booking-calendar" aria-labelledby="booking-calendar-title">
      <div className="cal-head">
        <Link className="cal-step" href={hrefFor(prev)} aria-label={`Previous month, ${formatMonth(prev)}`}>
          ‹
        </Link>
        <h2 id="booking-calendar-title">{name}</h2>
        <Link className="cal-step" href={hrefFor(next)} aria-label={`Next month, ${formatMonth(next)}`}>
          ›
        </Link>
      </div>

      <table className="cal-grid">
        <caption className="sr-only">Bookings in {name}</caption>
        <thead>
          <tr>
            {WEEKDAYS.map(([letter, day]) => (
              <th key={day} scope="col" abbr={day}>
                {letter}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {monthWeeks(month).map((week, i) => (
            <tr key={i}>
              {week.map((date, j) =>
                date ? (
                  <DayCell key={date} date={date} entries={byDate.get(date) ?? []} today={today} focusDate={focusDate} />
                ) : (
                  <td key={`blank-${j}`} className="cal-blank" />
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="cal-legend" aria-label="Key">
        {(Object.keys(KIND_LABEL) as CalendarKind[]).map((kind) => (
          <li key={kind}>
            <span className={`cal-swatch cal-${kind}`} aria-hidden="true" />
            {KIND_LABEL[kind]}
          </li>
        ))}
      </ul>

      {entries.length === 0 ? (
        <p className="cal-empty">Nothing booked or asked for in {name}.</p>
      ) : (
        <ol className="cal-list">
          {entries.map((entry, i) => (
            <EntryLine key={`${entry.date}-${i}`} entry={entry} />
          ))}
        </ol>
      )}
    </aside>
  );
}
