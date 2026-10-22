"use client";

import { useActionState } from "react";
import { MAPPING_FIELDS } from "@/lib/winback/csv";
import { importCustomersAction, syncWonLeadsAction, type ActionResult, type ImportState } from "../actions";

/**
 * Import past customers from a spreadsheet, in two steps: choose the file,
 * then confirm which column is which. The file is read on the server both
 * times — the browser only carries the text between the steps.
 */
export function ImportCustomersForm({ readOnly }: { readOnly: boolean }) {
  const [state, formAction, pending] = useActionState<ImportState, FormData>(importCustomersAction, { step: "idle" });
  const mapping = state.step === "map" || (state.step === "error" && state.headers) ? state : null;

  if (mapping && "headers" in mapping && mapping.headers && mapping.csv) {
    const sample = state.step === "map" ? state.sample : [];
    return (
      <form action={formAction} className="winback-form">
        <input type="hidden" name="step" value="import" />
        <input type="hidden" name="csv" value={mapping.csv} />
        <input type="hidden" name="fileName" value={mapping.fileName ?? ""} />
        <p style={{ marginTop: 0 }}>
          <strong>{mapping.fileName}</strong>: {mapping.rows} {mapping.rows === 1 ? "row" : "rows"}. Check which column is
          which. Anything you leave as &ldquo;Not in this file&rdquo; is skipped.
        </p>
        <div className="winback-mapping">
          {MAPPING_FIELDS.map(({ key, label }) => (
            <div key={key}>
              <label htmlFor={`map_${key}`}>{label}</label>
              <select id={`map_${key}`} name={`map_${key}`} defaultValue={mapping.mapping?.[key] ?? ""}>
                <option value="">Not in this file</option>
                {mapping.headers!.map((header, i) => (
                  <option key={i} value={i}>
                    {header || `Column ${i + 1}`}
                    {sample[0]?.[i] ? ` (e.g. ${sample[0][i]!.slice(0, 30)})` : ""}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
        <label className="winback-check">
          <input type="checkbox" name="confirm" value="yes" />
          <span>These are people who have bought from us. I&rsquo;m not importing a bought or scraped list.</span>
        </label>
        {state.step === "error" && (
          <p className="error" role="status">
            {state.message}
          </p>
        )}
        <div className="winback-buttons">
          <button type="submit" disabled={pending || readOnly}>
            {pending ? "Importing…" : "Import customers"}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form action={formAction} className="winback-form">
      <label htmlFor="winback-file">A CSV file of past customers</label>
      <input id="winback-file" type="file" name="file" accept=".csv,text/csv" required disabled={readOnly} />
      <p className="field-hint">
        Export it from your invoicing or booking app, or save a spreadsheet as CSV. It needs a column of email
        addresses; names, the date of their last job and what it was are useful too. Up to 5,000 rows at a time.
      </p>
      {state.step === "error" && (
        <p className="error" role="status">
          {state.message}
        </p>
      )}
      {state.step === "done" && (
        <p className="notice notice-success" role="status">
          {state.message}
        </p>
      )}
      <div className="winback-buttons">
        <button type="submit" className="secondary" disabled={pending || readOnly}>
          {pending ? "Reading…" : "Read the file"}
        </button>
      </div>
    </form>
  );
}

export function SyncWonLeadsForm({ readOnly }: { readOnly: boolean }) {
  const [state, formAction, pending] = useActionState<ActionResult | null>(syncWonLeadsAction, null);
  return (
    <form action={formAction}>
      <button type="submit" className="secondary" disabled={pending || readOnly}>
        {pending ? "Adding…" : "Add enquiries already marked won"}
      </button>
      {state && (
        <p className={state.ok ? "notice notice-success" : "error"} role="status">
          {state.message}
        </p>
      )}
    </form>
  );
}
