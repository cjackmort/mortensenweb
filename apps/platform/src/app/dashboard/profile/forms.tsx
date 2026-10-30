"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { BusinessProfileField } from "@/components/profile-field";
import { CLIENT_PROFILE_FIELDS, CLIENT_PROFILE_GROUPS, type ProfileGroup } from "@/lib/business-profile";
import { MAX_NAME_LENGTH } from "@/lib/profile/details";
import { saveBusinessAction, saveDetailsAction, type ProfileActionResult } from "./actions";

/**
 * The two text forms of the profile page: the person, and their business.
 *
 * Each keeps what was typed when a save is refused, and says in one line
 * what happened when it is accepted. Save is live only once something has
 * been changed, and says so beside it, so nobody wonders whether a click
 * did anything. Nothing here reaches the website on its own: the page says
 * so, and the business form's reply says it again.
 */

const READ_ONLY_HINT = "Viewing as the client: nothing here can be changed.";

/** How long a field linked to from elsewhere stays highlighted after arriving. */
const ARRIVAL_HIGHLIGHT_MS = 2800;

function Outcome({ state }: { state: ProfileActionResult | null }) {
  if (!state) return null;
  return <p className={state.ok ? "notice notice-success profile-outcome" : "error profile-outcome"}>{state.message}</p>;
}

/**
 * The foot of a form: what happened, and the button. A live region, so a
 * screen reader hears "Saved" or the refusal without hunting for it.
 */
function SaveBar({
  label,
  pending,
  dirty,
  state,
  readOnly,
}: {
  label: string;
  pending: boolean;
  dirty: boolean;
  state: ProfileActionResult | null;
  readOnly: boolean;
}) {
  // A refused save can be sent again as it is: the typed values are still there.
  const canSave = !readOnly && !pending && (dirty || state?.ok === false);
  return (
    <div className="profile-savebar">
      <div className="profile-savebar-status" role="status">
        {readOnly ? (
          <span className="muted">{READ_ONLY_HINT}</span>
        ) : dirty && !pending ? (
          <span className="profile-unsaved">Unsaved changes</span>
        ) : (
          !pending && <Outcome state={state} />
        )}
      </div>
      <button type="submit" disabled={!canSave}>
        {pending ? "Saving…" : label}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Name and email
// ---------------------------------------------------------------------------

export function DetailsForm({
  name,
  email,
  readOnly,
}: {
  name: string;
  email: string;
  readOnly: boolean;
}) {
  const [state, formAction, pending] = useActionState<ProfileActionResult | null, FormData>(
    saveDetailsAction,
    null,
  );
  const values = state?.values ?? { name, email };
  const errors = state?.errors ?? {};
  const [dirty, setDirty] = useState(false);
  const [typedEmail, setTypedEmail] = useState(values.email ?? email);
  // The password is asked for only when it is needed: a new sign-in email.
  const emailChanging = typedEmail.trim().toLowerCase() !== email.trim().toLowerCase();
  const askPassword = emailChanging || Boolean(errors.currentPassword);

  return (
    <form
      action={(formData) => {
        setDirty(false);
        formAction(formData);
      }}
      onInput={() => setDirty(true)}
      noValidate
    >
      <div className="profile-details-grid">
        <div className="profile-field">
          <label htmlFor="details-name">Your name</label>
          <input
            id="details-name"
            name="name"
            type="text"
            autoComplete="name"
            maxLength={MAX_NAME_LENGTH}
            defaultValue={values.name}
            disabled={readOnly || pending}
            aria-invalid={errors.name ? true : undefined}
          />
          {errors.name && <p className="error">{errors.name}</p>}
        </div>
        <div className="profile-field">
          <label htmlFor="details-email">Sign-in email</label>
          <input
            id="details-email"
            name="email"
            type="email"
            autoComplete="email"
            defaultValue={values.email}
            onChange={(event) => setTypedEmail(event.target.value)}
            disabled={readOnly || pending}
            aria-invalid={errors.email ? true : undefined}
            aria-describedby="details-email-hint"
          />
          <p className="field-hint" id="details-email-hint">
            Where we write to you, and what you sign in with.
          </p>
          {errors.email && <p className="error">{errors.email}</p>}
        </div>
        {askPassword ? (
          <div className="profile-field is-wide profile-confirm">
            <label htmlFor="details-password">Current password</label>
            <input
              id="details-password"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              disabled={readOnly || pending}
              aria-invalid={errors.currentPassword ? true : undefined}
              aria-describedby="details-password-hint"
            />
            <p className="field-hint" id="details-password-hint">
              To change the email you sign in with, confirm it&rsquo;s you.
            </p>
            {errors.currentPassword && <p className="error">{errors.currentPassword}</p>}
          </div>
        ) : (
          <p className="profile-password-row is-wide">
            <span>Password</span>
            <Link href="/change-password">Change your password</Link>
          </p>
        )}
      </div>
      <SaveBar label="Save details" pending={pending} dirty={dirty} state={state} readOnly={readOnly} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// General information about the business
// ---------------------------------------------------------------------------

/**
 * The groups as the client reads them. The field list names them for the
 * operator ("What they offer"); on the client's own page they are theirs.
 */
const GROUP_COPY: Record<ProfileGroup, { title: string; description: string }> = {
  "The business": { title: "The basics", description: "Your name as customers see it, and what you do." },
  Contact: { title: "Contact", description: "Calls, emails and bookings from your site go here." },
  "What they offer": { title: "What you offer", description: "Your services, prices and the areas you cover." },
  Online: { title: "Online", description: "Your other pages, so the site can link to them." },
  Credentials: {
    title: "Credentials",
    description: "Licences, insurance and awards customers can check.",
  },
  "Look and voice": { title: "Look and voice", description: "" },
};

/**
 * Bring a field linked to from elsewhere (`?field=address`) into view: scroll
 * it to the middle of the screen, put the cursor in it, and highlight it
 * briefly so the eye lands on it too.
 */
function useArrival(field: string | null): string | null {
  const [highlighted, setHighlighted] = useState(field);
  useEffect(() => {
    if (!field || !bringIntoView(field)) return;
    const timer = window.setTimeout(() => setHighlighted(null), ARRIVAL_HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [field]);
  return highlighted;
}

/** Scroll a business field to the middle of the screen and put the cursor in it. */
function bringIntoView(key: string): boolean {
  const input = document.getElementById(`profile-${key}`);
  if (!input) return false;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  input.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
  input.focus({ preventScroll: true });
  return true;
}

export function BusinessForm({
  details,
  readOnly,
  focusField,
}: {
  details: Record<string, string>;
  readOnly: boolean;
  /** A field to bring into view on arrival, already checked to be one of the client's. */
  focusField: string | null;
}) {
  const [state, formAction, pending] = useActionState<ProfileActionResult | null, FormData>(
    saveBusinessAction,
    null,
  );
  const [dirty, setDirty] = useState(false);
  const highlighted = useArrival(focusField);
  // A refused save takes the reader to the first field it names.
  useEffect(() => {
    const first = state?.errors && CLIENT_PROFILE_FIELDS.find((f) => state.errors?.[f.key]);
    if (first) bringIntoView(first.key);
  }, [state]);
  // A refused save shows what was typed, not what was stored.
  const values = state?.values ?? details;

  return (
    <form
      action={(formData) => {
        setDirty(false);
        formAction(formData);
      }}
      onInput={() => setDirty(true)}
      className="profile-business-form"
      noValidate
    >
      {CLIENT_PROFILE_GROUPS.map((group) => {
        const copy = GROUP_COPY[group];
        return (
          <fieldset key={group} className="profile-section" disabled={readOnly || pending}>
            <legend>{copy.title}</legend>
            {copy.description && <p className="profile-section-about">{copy.description}</p>}
            <div className="profile-grid">
              {CLIENT_PROFILE_FIELDS.filter((f) => f.group === group).map((field) => (
                <BusinessProfileField
                  key={field.key}
                  field={field}
                  value={values[field.key] ?? ""}
                  error={state?.errors?.[field.key]}
                  highlighted={highlighted === field.key}
                />
              ))}
            </div>
          </fieldset>
        );
      })}
      <SaveBar label="Save business details" pending={pending} dirty={dirty} state={state} readOnly={readOnly} />
    </form>
  );
}
