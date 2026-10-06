"use client";

import { useActionState } from "react";
import {
  PROFILE_FIELDS,
  PROFILE_GROUPS,
  type ProfileField,
} from "@/lib/business-profile";
import {
  saveProfileAction,
  sendProfileAction,
  type ProfileResult,
} from "./profile-actions";

/**
 * The client's general information.
 *
 * Grouped the way an operator collects it on a call — the business, how to
 * reach it, what it sells, where it is online — so the form can be filled top
 * to bottom while talking. Every field is optional: a half-filled profile is
 * still everything the agent did not know before.
 */

interface ProfilePanelProps {
  clientPublicId: string;
  details: Record<string, string>;
  sites: { publicId: string; name: string }[];
  updatedAt: string | null;
  lastAppliedAt: string | null;
}

function Field({
  field,
  value,
  error,
}: {
  field: ProfileField;
  value: string;
  error?: string;
}) {
  const id = `profile-${field.key}`;
  const hintId = field.hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const common = {
    id,
    name: field.key,
    defaultValue: value,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
  };

  return (
    <div className={field.kind === "text" ? "profile-field profile-field-wide" : "profile-field"}>
      <label htmlFor={id}>{field.label}</label>
      {field.kind === "text" ? (
        <textarea {...common} rows={field.key === "hours" || field.key === "address" ? 3 : 4} />
      ) : (
        <input
          {...common}
          type={field.kind === "url" ? "url" : field.kind === "email" ? "email" : field.kind === "phone" ? "tel" : "text"}
          inputMode={field.kind === "phone" ? "tel" : undefined}
          placeholder={field.kind === "url" ? "https://" : undefined}
        />
      )}
      {field.hint && (
        <p className="field-hint" id={hintId}>
          {field.hint}
        </p>
      )}
      {error && (
        <p className="error" id={errorId}>
          {error}
        </p>
      )}
    </div>
  );
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function ProfilePanel({ clientPublicId, details, sites, updatedAt, lastAppliedAt }: ProfilePanelProps) {
  const [saveState, saveAction, saving] = useActionState<ProfileResult | null, FormData>(saveProfileAction, null);
  const [sendState, sendAction, sending] = useActionState<ProfileResult | null, FormData>(sendProfileAction, null);

  // A refused save shows what was typed, not what was stored.
  const values = saveState?.values ?? details;
  const filled = PROFILE_FIELDS.filter((f) => details[f.key]).length;
  const changedSinceSent =
    updatedAt !== null && (lastAppliedAt === null || new Date(updatedAt) > new Date(lastAppliedAt));

  return (
    <>
      <p className="profile-status">
        {filled === 0
          ? "Nothing filled in yet. Until there is, the agent uses placeholders for business details."
          : `${filled} of ${PROFILE_FIELDS.length} filled in. Attached to every agent run for this client.`}
        {updatedAt && <> Last saved {formatDate(updatedAt)}.</>}
        {lastAppliedAt && <> Last put on the site {formatDate(lastAppliedAt)}.</>}
      </p>

      <form action={saveAction} className="profile-form" noValidate>
        <input type="hidden" name="clientPublicId" value={clientPublicId} />

        {PROFILE_GROUPS.map((group) => (
          <fieldset key={group} className="profile-group">
            <legend>{group}</legend>
            <div className="profile-grid">
              {PROFILE_FIELDS.filter((f) => f.group === group).map((field) => (
                <Field
                  key={field.key}
                  field={field}
                  value={values[field.key] ?? ""}
                  error={saveState?.errors?.[field.key]}
                />
              ))}
            </div>
          </fieldset>
        ))}

        {saveState && (
          <p className={saveState.ok ? "notice notice-success" : "error"} role="status">
            {saveState.message}
          </p>
        )}
        <div className="actions">
          <button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save general information"}
          </button>
        </div>
      </form>

      {filled > 0 && sites.length > 0 && (
        <form action={sendAction} className="profile-send">
          <input type="hidden" name="clientPublicId" value={clientPublicId} />
          <div>
            <h3>Put it on the site</h3>
            <p className="field-hint">
              {changedSinceSent
                ? "Changed since it was last put on the site. "
                : ""}
              Opens one change that brings the whole site in line with these
              details. You check the preview first, then the client approves it.
            </p>
          </div>
          {sites.length > 1 ? (
            <select name="sitePublicId" aria-label="Site to update" defaultValue={sites[0]!.publicId}>
              {sites.map((site) => (
                <option key={site.publicId} value={site.publicId}>
                  {site.name}
                </option>
              ))}
            </select>
          ) : (
            <input type="hidden" name="sitePublicId" value={sites[0]!.publicId} />
          )}
          <button type="submit" className="secondary" disabled={sending}>
            {sending ? "Sending…" : "Put it on the site"}
          </button>
          {sendState && (
            <p className={sendState.ok ? "notice notice-success" : "error"} role="status">
              {sendState.message}
            </p>
          )}
        </form>
      )}
    </>
  );
}
