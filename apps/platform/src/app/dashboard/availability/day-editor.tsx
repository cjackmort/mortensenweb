"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { rangesToFields, weekdayName, type DayBooking } from "@/lib/availability/calendar";
import { formatDay, formatRange } from "@/lib/availability/format";
import { MAX_RANGES_PER_DAY, type TimeRange } from "@/lib/availability/slots";
import { removeDayAction, saveDayAction, type AvailabilityActionResult } from "./actions";

/**
 * One day's open times, in a dialog opened from the calendar. Add or remove
 * blocks of time, or close the day; saved as that date's own hours. "Repeat
 * every Tuesday" saves them as the weekly hours instead.
 *
 * A native `<dialog>` opened with `showModal()`: focus is trapped inside,
 * Escape closes it, and focus returns to the day that was pressed.
 *
 * The server actions are called directly rather than through a form action:
 * React resets a form after its action runs, and a reset puts controlled
 * fields back to what the page first drew while the state says otherwise.
 */

interface Block {
  id: number;
  start: string;
  end: string;
}

const DEFAULT_BLOCK = { start: "09:00", end: "17:00" };
const FAILED: AvailabilityActionResult = { ok: false, message: "Something went wrong saving that. Try again." };

let nextId = 1;
const block = (start: string, end: string): Block => ({ id: nextId++, start, end });

export interface DayEditorProps {
  date: string;
  /** The hours the day has now, from its own or its weekday's. */
  ranges: TimeRange[];
  /** The day has hours of its own, to go back from. */
  overridePublicId: string | null;
  /** What its weekday gives when the day has nothing of its own. */
  usual: TimeRange[];
  bookings: DayBooking[];
  readOnly: boolean;
  onClose: () => void;
  /** Saved: the calendar shows this message, and the dialog is closed. */
  onDone: (message: string) => void;
}

export function DayEditor({ date, ranges, overridePublicId, usual, bookings, readOnly, onClose, onDone }: DayEditorProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(ranges.length > 0);
  const [blocks, setBlocks] = useState<Block[]>(() => rangesToFields(ranges).map((r) => block(r.start, r.end)));
  const [repeat, setRepeat] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const disabled = readOnly || pending;
  const weekday = weekdayName(date);

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  const close = () => dialog.current?.close();

  const finish = (result: AvailabilityActionResult) => {
    if (!result.ok) return setError(result.message);
    onDone(result.message);
    close();
  };

  const submit = (action: () => Promise<AvailabilityActionResult>) =>
    startTransition(async () => {
      setError(null);
      try {
        finish(await action());
      } catch {
        setError(FAILED.message);
      }
    });

  const save = () => {
    const form = new FormData();
    form.set("date", date);
    form.set("mode", open ? "hours" : "closed");
    form.set("ranges", JSON.stringify(open ? blocks.map(({ start, end }) => ({ start, end })) : []));
    if (repeat) form.set("repeat", "weekly");
    submit(() => saveDayAction(null, form));
  };

  const useUsualHours = () => {
    const form = new FormData();
    form.set("day", overridePublicId ?? "");
    submit(() => removeDayAction(null, form));
  };

  const toggleOpen = (next: boolean) => {
    setOpen(next);
    if (next && blocks.length === 0) setBlocks([block(DEFAULT_BLOCK.start, DEFAULT_BLOCK.end)]);
  };

  const update = (id: number, change: Partial<Pick<Block, "start" | "end">>) =>
    setBlocks((all) => all.map((b) => (b.id === id ? { ...b, ...change } : b)));

  const addBlock = () => {
    const last = blocks.at(-1);
    setBlocks([...blocks, block(last?.end && last.end !== "00:00" ? last.end : "13:00", "17:00")]);
  };

  const usualText =
    usual.length === 0 ? `You're usually closed on ${weekday}s.` : `Your usual ${weekday} hours: ${usual.map(formatRange).join(", ")}.`;

  return (
    <dialog
      ref={dialog}
      className="avail-dialog"
      aria-labelledby="avail-dialog-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <form
        className="avail-dialog-body"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <div className="avail-dialog-head">
          <div>
            <h2 id="avail-dialog-title">{formatDay(date, "long")}</h2>
            <p className="muted avail-dialog-sub">
              {overridePublicId ? `This day has its own hours. ${usualText}` : usualText}
            </p>
          </div>
          <button type="button" className="avail-dialog-x" onClick={close} aria-label="Close without saving">
            <span aria-hidden="true">×</span>
          </button>
        </div>

        {bookings.length > 0 && (
          <div className="avail-dialog-bookings">
            <h3>Booked on this day</h3>
            <ul>
              {bookings.map((b) => (
                <li key={b.publicId}>
                  <span>
                    {b.time} · {b.name}
                  </span>
                  <span className={`pill ${b.status === "pending" ? "pill-warning" : "pill-success"}`}>
                    {b.status === "pending" ? "Waiting for your answer" : "Confirmed"}
                  </span>
                </li>
              ))}
            </ul>
            <p className="field-hint">
              Changing the hours doesn&rsquo;t cancel these.{" "}
              {bookings.some((b) => b.status === "pending") && (
                <>
                  Answer a request under{" "}
                  <a href="#avail-pending" onClick={close}>
                    Waiting for your answer
                  </a>
                  .
                </>
              )}
            </p>
          </div>
        )}

        <label className="avail-day-toggle">
          <input type="checkbox" checked={open} disabled={disabled} onChange={(e) => toggleOpen(e.target.checked)} />
          <span>Open this day</span>
        </label>

        {open ? (
          <div className="avail-dialog-blocks">
            {blocks.map((b, i) => (
              <div key={b.id} className="avail-block">
                <input
                  type="time"
                  step={900}
                  value={b.start}
                  disabled={disabled}
                  aria-label={`Block ${i + 1}, from`}
                  onChange={(e) => update(b.id, { start: e.target.value })}
                />
                <span className="avail-to" aria-hidden="true">
                  to
                </span>
                <input
                  type="time"
                  step={900}
                  value={b.end}
                  disabled={disabled}
                  aria-label={`Block ${i + 1}, until`}
                  onChange={(e) => update(b.id, { end: e.target.value })}
                />
                <button
                  type="button"
                  className="avail-remove"
                  disabled={disabled || blocks.length === 1}
                  aria-label={`Remove block ${i + 1}`}
                  onClick={() => setBlocks(blocks.filter((x) => x.id !== b.id))}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>
            ))}
            <div className="avail-dialog-tools">
              <button type="button" className="link" disabled={disabled || blocks.length >= MAX_RANGES_PER_DAY} onClick={addBlock}>
                Add hours
              </button>
            </div>
          </div>
        ) : (
          <p className="muted avail-dialog-closed">Closed. Your website offers no times on this day.</p>
        )}

        <label className="avail-day-toggle avail-repeat">
          <input type="checkbox" checked={repeat} disabled={disabled} onChange={(e) => setRepeat(e.target.checked)} />
          <span>Repeat every {weekday}</span>
        </label>
        <p className="field-hint avail-repeat-hint">
          {repeat
            ? `Sets your weekly hours for every ${weekday}. Days you changed one by one keep their own hours.`
            : `Just ${formatDay(date)}. Other ${weekday}s follow your weekly hours.`}
        </p>

        {readOnly && <p className="notice notice-info">You are viewing as the client, so nothing here can be changed.</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <div className="avail-dialog-actions">
          <button type="submit" disabled={disabled}>
            {pending ? "Saving…" : "Save"}
          </button>
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          {overridePublicId && !repeat && (
            <button type="button" className="link" disabled={disabled} onClick={useUsualHours}>
              Use my usual {weekday} hours
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
