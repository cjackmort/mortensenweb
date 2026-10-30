"use client";

import { startTransition, useActionState, useState } from "react";
import { removeDayAction, saveDayAction, type AvailabilityActionResult } from "./actions";

/**
 * Days off and days with different hours: a holiday, a half day, a Saturday
 * opened for once. One date at a time; saving a date again replaces it.
 */

export interface DayOffView {
  publicId: string;
  /** `Thu, Dec 24`. */
  dayLabel: string;
  /** `Closed`, or `9:00 AM – 12:00 PM`. */
  hoursLabel: string;
  closed: boolean;
}

export function DaysOff({ days, today, readOnly }: { days: DayOffView[]; today: string; readOnly: boolean }) {
  const [saveState, saveAction, saving] = useActionState<AvailabilityActionResult | null, FormData>(saveDayAction, null);
  const [removeState, removeAction, removing] = useActionState<AvailabilityActionResult | null, FormData>(removeDayAction, null);
  const [mode, setMode] = useState<"closed" | "hours">("closed");
  const [date, setDate] = useState("");
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("12:00");
  const [last, setLast] = useState<"save" | "remove" | null>(null);
  const state = last === "remove" ? removeState : last === "save" ? saveState : null;

  // A saved date is cleared from the field, ready for the next one. Done
  // while rendering, when a new result arrives, rather than in an effect.
  const [seenSave, setSeenSave] = useState(saveState);
  if (saveState !== seenSave) {
    setSeenSave(saveState);
    if (saveState?.ok) setDate("");
  }
  const disabled = readOnly || saving || removing;

  return (
    <div className="avail-daysoff">
      <form
        className="avail-dayoff-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData();
          form.set("date", date);
          form.set("mode", mode);
          form.set("start", start);
          form.set("end", end);
          setLast("save");
          startTransition(() => saveAction(form));
        }}
      >
        <div className="avail-dayoff-date">
          <label htmlFor="avail-dayoff-date">Date</label>
          <input
            id="avail-dayoff-date"
            type="date"
            min={today}
            value={date}
            required
            disabled={disabled}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <fieldset className="avail-dayoff-mode" disabled={disabled}>
          <legend>That day</legend>
          <label className="checkbox">
            <input type="radio" name="mode" checked={mode === "closed"} onChange={() => setMode("closed")} />
            Closed all day
          </label>
          <label className="checkbox">
            <input type="radio" name="mode" checked={mode === "hours"} onChange={() => setMode("hours")} />
            Different hours
          </label>
        </fieldset>
        {mode === "hours" && (
          <div className="avail-block avail-dayoff-hours">
            <input type="time" step={900} value={start} disabled={disabled} aria-label="From" onChange={(e) => setStart(e.target.value)} />
            <span className="avail-to" aria-hidden="true">
              to
            </span>
            <input type="time" step={900} value={end} disabled={disabled} aria-label="Until" onChange={(e) => setEnd(e.target.value)} />
          </div>
        )}
        <button type="submit" className="secondary" disabled={disabled || !date}>
          {saving ? "Saving…" : "Add"}
        </button>
      </form>

      {state && (
        <p className={state.ok ? "notice notice-success" : "error"} role="status">
          {state.message}
        </p>
      )}

      {days.length === 0 ? (
        <p className="muted avail-empty-line">No days off coming up. Every date follows your weekly hours.</p>
      ) : (
        <ul className="avail-dayoff-list">
          {days.map((day) => (
            <li key={day.publicId}>
              <span className="avail-dayoff-day">{day.dayLabel}</span>
              <span className={day.closed ? "pill pill-neutral" : "avail-dayoff-hours-label"}>{day.hoursLabel}</span>
              <form action={removeAction} onSubmit={() => setLast("remove")}>
                <input type="hidden" name="day" value={day.publicId} />
                <button type="submit" className="link" disabled={disabled} aria-label={`Remove ${day.dayLabel}`}>
                  Remove
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
