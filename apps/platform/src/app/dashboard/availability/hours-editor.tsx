"use client";

import { startTransition, useActionState, useMemo, useState } from "react";
import { saveHoursAction, type AvailabilityActionResult } from "./actions";

/**
 * The weekly hours: each day open or closed, with one or more blocks of
 * time. Edited here in the browser and saved as a whole week, so a half-made
 * change never reaches the website.
 *
 * Times are the browser's own time fields, which give a proper picker on a
 * phone. Midnight at the end of a day is `00:00` in the "until" field — the
 * only way a time field can say it.
 *
 * Submitted by hand rather than as a form action: React resets a form after
 * its action runs, and a reset puts controlled fields back to what the page
 * first drew while the state says otherwise.
 */

type Day = 0 | 1 | 2 | 3 | 4 | 5 | 6;
interface Block {
  id: number;
  start: string;
  end: string;
}
type Week = Record<Day, Block[]>;

/** Monday first: how a business writes its hours. */
const ORDER: Day[] = [1, 2, 3, 4, 5, 6, 0];
const NAMES: Record<Day, string> = {
  0: "Sunday",
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
};
const WORKDAYS: Day[] = [1, 2, 3, 4, 5];
const DEFAULT_BLOCK = { start: "09:00", end: "17:00" };

let nextId = 1;
const block = (start: string, end: string): Block => ({ id: nextId++, start, end });

function clock(minutes: number): string {
  const m = minutes % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function toWeek(initial: Record<number, Array<{ start: number; end: number }>>): Week {
  const week = {} as Week;
  for (const day of ORDER) week[day] = (initial[day] ?? []).map((r) => block(clock(r.start), clock(r.end)));
  return week;
}

function serialize(week: Week): string {
  return JSON.stringify(
    Object.fromEntries(ORDER.map((day) => [String(day), week[day].map(({ start, end }) => ({ start, end }))])),
  );
}

export function HoursEditor({
  initial,
  readOnly,
}: {
  initial: Record<number, Array<{ start: number; end: number }>>;
  readOnly: boolean;
}) {
  const [state, formAction, pending] = useActionState<AvailabilityActionResult | null, FormData>(saveHoursAction, null);
  const [week, setWeek] = useState<Week>(() => toWeek(initial));
  const saved = useMemo(() => serialize(toWeek(initial)), [initial]);
  const current = serialize(week);
  const dirty = current !== saved;
  const disabled = readOnly || pending;

  const update = (day: Day, blocks: Block[]) => setWeek((w) => ({ ...w, [day]: blocks }));
  const copyToWorkdays = (from: Day) =>
    setWeek((w) => {
      const next = { ...w };
      for (const day of WORKDAYS) next[day] = w[from].map((b) => block(b.start, b.end));
      return next;
    });

  return (
    <form
      className="avail-hours"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData();
        form.set("hours", current);
        startTransition(() => formAction(form));
      }}
    >
      <ul className="avail-days">
        {ORDER.map((day) => {
          const blocks = week[day];
          const open = blocks.length > 0;
          return (
            <li key={day} className={`avail-day${open ? "" : " avail-day--closed"}`}>
              <label className="avail-day-toggle">
                <input
                  type="checkbox"
                  checked={open}
                  disabled={disabled}
                  onChange={(e) => update(day, e.target.checked ? [block(DEFAULT_BLOCK.start, DEFAULT_BLOCK.end)] : [])}
                />
                <span>{NAMES[day]}</span>
              </label>

              <div className="avail-day-blocks">
                {!open && <span className="avail-closed">Closed</span>}
                {blocks.map((b, i) => (
                  <div key={b.id} className="avail-block">
                    <input
                      type="time"
                      step={900}
                      value={b.start}
                      disabled={disabled}
                      aria-label={`${NAMES[day]}, block ${i + 1}, from`}
                      onChange={(e) => update(day, blocks.map((x) => (x.id === b.id ? { ...x, start: e.target.value } : x)))}
                    />
                    <span className="avail-to" aria-hidden="true">
                      to
                    </span>
                    <input
                      type="time"
                      step={900}
                      value={b.end}
                      disabled={disabled}
                      aria-label={`${NAMES[day]}, block ${i + 1}, until`}
                      onChange={(e) => update(day, blocks.map((x) => (x.id === b.id ? { ...x, end: e.target.value } : x)))}
                    />
                    <button
                      type="button"
                      className="avail-remove"
                      disabled={disabled}
                      aria-label={`Remove ${NAMES[day]} block ${i + 1}`}
                      onClick={() => update(day, blocks.filter((x) => x.id !== b.id))}
                    >
                      <span aria-hidden="true">×</span>
                    </button>
                  </div>
                ))}
              </div>

              {open && (
                <div className="avail-day-tools">
                  <button
                    type="button"
                    className="link"
                    disabled={disabled}
                    onClick={() => {
                      const last = blocks.at(-1);
                      update(day, [...blocks, block(last?.end && last.end !== "00:00" ? last.end : "13:00", "17:00")]);
                    }}
                  >
                    Add hours
                  </button>
                  <button type="button" className="link" disabled={disabled} onClick={() => copyToWorkdays(day)}>
                    Copy to Mon–Fri
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {state && (
        <p className={state.ok ? "notice notice-success" : "error"} role="status">
          {state.message}
        </p>
      )}
      <div className="avail-save">
        <button type="submit" disabled={disabled || !dirty}>
          {pending ? "Saving…" : "Save hours"}
        </button>
        {dirty && !pending && <span className="hint">Not saved yet</span>}
      </div>
    </form>
  );
}
