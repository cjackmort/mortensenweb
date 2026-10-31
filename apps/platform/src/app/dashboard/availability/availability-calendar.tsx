"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { compactHours, dayHours, type DayBooking } from "@/lib/availability/calendar";
import { formatDay, formatRange } from "@/lib/availability/format";
import type { FullWeek, TimeRange } from "@/lib/availability/slots";
import { addDays, weekdayOf } from "@/lib/availability/time";
import { formatMonth, monthBounds, monthOf, monthWeeks, shiftMonth } from "@/lib/growth/booking-calendar";
import { DayEditor } from "./day-editor";

/**
 * The month at a glance, and the way to set it: each day shows whether it is
 * open and its hours, with requests and confirmed bookings marked. Pressing a
 * day opens its hours to change.
 *
 * Nothing is told by colour alone. Closed days say "Closed" and are hatched,
 * days with their own hours carry a corner mark, requests are `1?` and
 * confirmed bookings `1✓` (with words where there is room), and every day's
 * button says all of it in its label.
 *
 * Days are buttons in an ordinary table, so Tab reaches each one; the arrow
 * keys, Home, End and Page Up/Down move between days as a convenience.
 */

export interface CalendarOverride {
  publicId: string;
  date: string;
  ranges: TimeRange[];
}

export interface AvailabilityCalendarProps {
  weekly: FullWeek;
  overrides: CalendarOverride[];
  bookings: Record<string, DayBooking[]>;
  today: string;
  /** The last date the website offers for booking now. */
  lastBookable: string;
  readOnly: boolean;
}

const WEEKDAYS: Array<[string, string]> = [
  ["S", "Sunday"],
  ["M", "Monday"],
  ["T", "Tuesday"],
  ["W", "Wednesday"],
  ["T", "Thursday"],
  ["F", "Friday"],
  ["S", "Saturday"],
];

/** A year ahead covers a holiday booked well in advance. */
const MONTHS_AHEAD = 12;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function dayLabel(args: {
  date: string;
  ranges: TimeRange[];
  own: boolean;
  isPast: boolean;
  isToday: boolean;
  beyond: boolean;
  pending: number;
  confirmed: number;
}): string {
  const { date, ranges, own, isPast, isToday, beyond, pending, confirmed } = args;
  const parts = [`${formatDay(date, "long")}${isToday ? ", today" : ""}`];
  if (isPast) return `${parts[0]}, has passed`;
  parts.push(ranges.length === 0 ? "closed" : `open ${ranges.map(formatRange).join(" and ")}`);
  if (own) parts.push("your own hours for this day");
  if (beyond) parts.push("not offered on your website yet");
  if (pending > 0) parts.push(`${plural(pending, "request", "requests")} waiting for your answer`);
  if (confirmed > 0) parts.push(plural(confirmed, "confirmed booking", "confirmed bookings"));
  return `${parts.join(". ")}. Press to change the hours.`;
}

export function AvailabilityCalendar({ weekly, overrides, bookings, today, lastBookable, readOnly }: AvailabilityCalendarProps) {
  const firstMonth = monthOf(today);
  const lastMonth = shiftMonth(firstMonth, MONTHS_AHEAD);
  const [month, setMonth] = useState(firstMonth);
  const [editing, setEditing] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const grid = useRef<HTMLTableElement>(null);
  const focusAfterRender = useRef<string | null>(null);

  const ownHours = useMemo(() => new Map(overrides.map((o) => [o.date, o.ranges])), [overrides]);
  const weeks = monthWeeks(month);

  // Moving to another month with the keyboard: the day to land on is drawn
  // only once the month is, so focus waits for it.
  useEffect(() => {
    const target = focusAfterRender.current;
    if (!target) return;
    focusAfterRender.current = null;
    grid.current?.querySelector<HTMLElement>(`[data-date="${target}"]`)?.focus();
  }, [month]);

  const earliest = `${firstMonth}-01`;
  const latest = monthBounds(lastMonth).last;

  const moveFocus = (from: string, key: string): string | null => {
    const day = Number(from.slice(8));
    const wanted: Record<string, () => string> = {
      ArrowLeft: () => addDays(from, -1),
      ArrowRight: () => addDays(from, 1),
      ArrowUp: () => addDays(from, -7),
      ArrowDown: () => addDays(from, 7),
      Home: () => addDays(from, -weekdayOf(from)),
      End: () => addDays(from, 6 - weekdayOf(from)),
      PageUp: () => pageMonth(-1),
      PageDown: () => pageMonth(1),
    };
    function pageMonth(delta: number): string {
      const m = shiftMonth(monthOf(from), delta);
      return `${m}-${String(Math.min(day, Number(monthBounds(m).last.slice(8)))).padStart(2, "0")}`;
    }
    const target = wanted[key]?.();
    if (!target) return null;
    return target < earliest || target > latest ? from : target;
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTableElement>) => {
    const from = (event.target as HTMLElement).dataset.date;
    if (!from) return;
    const target = moveFocus(from, event.key);
    if (!target) return;
    event.preventDefault();
    if (monthOf(target) === month) {
      grid.current?.querySelector<HTMLElement>(`[data-date="${target}"]`)?.focus();
    } else {
      focusAfterRender.current = target;
      setMonth(monthOf(target));
    }
  };

  const name = formatMonth(month);
  const editingHours = editing ? dayHours(editing, weekly, ownHours) : null;
  const editingOverride = editing ? (overrides.find((o) => o.date === editing) ?? null) : null;

  return (
    <div className="avail-cal">
      <div className="avail-cal-head">
        <button
          type="button"
          className="secondary avail-cal-step"
          onClick={() => setMonth(shiftMonth(month, -1))}
          disabled={month <= firstMonth}
          aria-label={`Previous month, ${formatMonth(shiftMonth(month, -1))}`}
        >
          <span aria-hidden="true">‹</span>
        </button>
        <h3 className="avail-cal-title" aria-live="polite">
          {name}
        </h3>
        <button
          type="button"
          className="secondary avail-cal-step"
          onClick={() => setMonth(shiftMonth(month, 1))}
          disabled={month >= lastMonth}
          aria-label={`Next month, ${formatMonth(shiftMonth(month, 1))}`}
        >
          <span aria-hidden="true">›</span>
        </button>
        {month !== firstMonth && (
          <button type="button" className="link avail-cal-today" onClick={() => setMonth(firstMonth)}>
            This month
          </button>
        )}
      </div>

      {status && (
        <p className="notice notice-success" role="status">
          {status}
        </p>
      )}

      <table className="avail-cal-grid" ref={grid} onKeyDown={onKeyDown}>
        <caption className="sr-only">
          Your hours in {name}. Press a day to change its open times.
        </caption>
        <thead>
          <tr>
            {WEEKDAYS.map(([letter, day]) => (
              <th key={day} scope="col" abbr={day}>
                <span aria-hidden="true">{letter}</span>
                <span className="sr-only">{day}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week.find(Boolean) ?? "empty"}>
              {week.map((date, i) => {
                if (!date) return <td key={`gap-${i}`} className="avail-cal-gap" />;
                const { ranges, own } = dayHours(date, weekly, ownHours);
                const isPast = date < today;
                const isToday = date === today;
                const beyond = date > lastBookable;
                const dayBookings = bookings[date] ?? [];
                const pending = dayBookings.filter((b) => b.status === "pending").length;
                const confirmed = dayBookings.length - pending;
                const closed = ranges.length === 0;
                const classes = [
                  "avail-cal-day",
                  closed ? "avail-cal-day--closed" : "avail-cal-day--open",
                  own ? "avail-cal-day--own" : "",
                  isPast ? "avail-cal-day--past" : "",
                  isToday ? "avail-cal-day--today" : "",
                  beyond && !isPast ? "avail-cal-day--beyond" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <td key={date}>
                    <button
                      type="button"
                      className={classes}
                      data-date={date}
                      aria-disabled={isPast || undefined}
                      aria-haspopup={isPast ? undefined : "dialog"}
                      aria-label={dayLabel({ date, ranges, own, isPast, isToday, beyond, pending, confirmed })}
                      onClick={() => {
                        if (!isPast) setEditing(date);
                      }}
                    >
                      <span className="avail-cal-num" aria-hidden="true">
                        {Number(date.slice(8))}
                      </span>
                      {!isPast && (
                        <>
                          <span className="avail-cal-hours" aria-hidden="true">
                            {compactHours(ranges)}
                          </span>
                          <span className="avail-cal-state" aria-hidden="true">
                            {closed ? "Closed" : "Open"}
                          </span>
                        </>
                      )}
                      {pending > 0 && (
                        <span className="avail-cal-mark avail-cal-mark--pending" aria-hidden="true">
                          {pending}?<span className="avail-cal-word"> asked</span>
                        </span>
                      )}
                      {confirmed > 0 && (
                        <span className="avail-cal-mark avail-cal-mark--confirmed" aria-hidden="true">
                          {confirmed}✓<span className="avail-cal-word"> booked</span>
                        </span>
                      )}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="avail-cal-legend">
        <li>
          <span className="avail-cal-key avail-cal-key--closed" aria-hidden="true" />
          Closed
        </li>
        <li>
          <span className="avail-cal-key avail-cal-key--own" aria-hidden="true" />
          Corner mark: hours you set for that day
        </li>
        <li>
          <strong aria-hidden="true">1?</strong> a request waiting for your answer
        </li>
        <li>
          <strong aria-hidden="true">1✓</strong> a confirmed booking
        </li>
        <li>
          <span className="avail-cal-key avail-cal-key--beyond" aria-hidden="true" />
          Dotted: your website doesn&rsquo;t offer it yet
        </li>
      </ul>

      {editing && editingHours && (
        <DayEditor
          key={editing}
          date={editing}
          ranges={editingHours.ranges}
          overridePublicId={editingOverride?.publicId ?? null}
          usual={weekly[weekdayOf(editing) as keyof FullWeek]}
          bookings={bookings[editing] ?? []}
          readOnly={readOnly}
          onClose={() => setEditing(null)}
          onDone={setStatus}
        />
      )}
    </div>
  );
}
