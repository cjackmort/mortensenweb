"use client";

import { startTransition, useActionState } from "react";
import type { AvailabilityRules } from "@/lib/availability/rules";
import { saveRulesAction, type AvailabilityActionResult } from "./actions";

/**
 * How a booking works: the approval checkbox first, because it changes what
 * a customer is told the moment they book, then the slot rules.
 *
 * Submitted by hand rather than as a form action, so React does not reset
 * the fields after a save: they already show what was saved, and a reset
 * would put them back to the values the page first drew.
 */

export interface RuleOptions {
  timeZones: ReadonlyArray<{ value: string; label: string }>;
  slotLengths: ReadonlyArray<{ value: number; label: string }>;
  buffers: ReadonlyArray<{ value: number; label: string }>;
  notices: ReadonlyArray<{ value: number; label: string }>;
  horizons: ReadonlyArray<{ value: number; label: string }>;
}

/** The saved value stays selectable even if it is no longer one of the offered choices. */
function withCurrent(options: RuleOptions["buffers"], current: number, label: string) {
  return options.some((o) => o.value === current) ? options : [...options, { value: current, label }].sort((a, b) => a.value - b.value);
}

export function RulesForm({
  rules,
  options,
  saved,
  readOnly,
  labels,
}: {
  rules: AvailabilityRules;
  options: RuleOptions;
  saved: boolean;
  readOnly: boolean;
  labels: { slot: string; buffer: string; notice: string; horizon: string };
}) {
  const [state, formAction, pending] = useActionState<AvailabilityActionResult | null, FormData>(saveRulesAction, null);
  const disabled = readOnly || pending;
  const zones = options.timeZones.some((z) => z.value === rules.timeZone)
    ? options.timeZones
    : [...options.timeZones, { value: rules.timeZone, label: rules.timeZone }];

  return (
    <form
      className="avail-rules"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        startTransition(() => formAction(form));
      }}
    >
      <label className="avail-approval">
        <input type="checkbox" name="requiresApproval" defaultChecked={rules.requiresApproval} disabled={disabled} />
        <span>
          <strong>Approve each booking before it&rsquo;s confirmed</strong>
          <span className="avail-approval-on">
            On: a booking holds the time as a request until you approve or decline it here. The customer is emailed
            either way.
          </span>
          <span className="avail-approval-off">
            Off: an open time is confirmed as soon as someone books it, and they&rsquo;re emailed a confirmation.
          </span>
        </span>
      </label>

      <div className="avail-rule-grid">
        <div>
          <label htmlFor="avail-slot">Appointment length</label>
          <select id="avail-slot" name="slotMinutes" defaultValue={rules.slotMinutes} disabled={disabled}>
            {withCurrent(options.slotLengths, rules.slotMinutes, labels.slot).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="avail-buffer">Gap between appointments</label>
          <select id="avail-buffer" name="bufferMinutes" defaultValue={rules.bufferMinutes} disabled={disabled}>
            {withCurrent(options.buffers, rules.bufferMinutes, labels.buffer).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="avail-notice">Shortest notice</label>
          <select id="avail-notice" name="minNoticeMinutes" defaultValue={rules.minNoticeMinutes} disabled={disabled}>
            {withCurrent(options.notices, rules.minNoticeMinutes, labels.notice).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="avail-horizon">How far ahead</label>
          <select id="avail-horizon" name="horizonDays" defaultValue={rules.horizonDays} disabled={disabled}>
            {withCurrent(options.horizons, rules.horizonDays, labels.horizon).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="avail-rule-wide">
          <label htmlFor="avail-zone">Your timezone</label>
          <select id="avail-zone" name="timeZone" defaultValue={rules.timeZone} disabled={disabled}>
            {zones.map((z) => (
              <option key={z.value} value={z.value}>
                {z.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {state && (
        <p className={state.ok ? "notice notice-success" : "error"} role="status">
          {state.message}
        </p>
      )}
      <div className="avail-save">
        <button type="submit" disabled={disabled}>
          {pending ? "Saving…" : "Save booking rules"}
        </button>
        {!saved && <span className="hint">These are the starting settings. Save to keep them.</span>}
      </div>
    </form>
  );
}
