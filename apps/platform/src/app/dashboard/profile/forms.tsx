"use client";

import Link from "next/link";
import { startTransition, useActionState, useState } from "react";
import { BusinessProfileField } from "@/components/profile-field";
import { PROFILE_FIELDS, PROFILE_GROUPS } from "@/lib/business-profile";
import { MAX_NAME_LENGTH } from "@/lib/profile/details";
import {
  removeAvatarAction,
  saveBusinessAction,
  saveDetailsAction,
  uploadAvatarAction,
  type ProfileActionResult,
} from "./actions";

/**
 * The three forms of the profile page.
 *
 * Each keeps what was typed when a save is refused, and says in one line
 * what happened when it is accepted. Nothing here reaches the website on
 * its own: the page says so, and the business form's reply says it again.
 */

const READ_ONLY_HINT = "Viewing as the client: nothing here can be changed.";

function Outcome({ state }: { state: ProfileActionResult | null }) {
  if (!state) return null;
  return (
    <p className={state.ok ? "notice notice-success" : "error"} role="status">
      {state.message}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Picture
// ---------------------------------------------------------------------------

/** Longest edge a photo is shrunk to in the browser before it is sent. */
const SEND_EDGE = 512;
/** Below this it is sent as chosen: re-encoding would cost more than it saves. */
const SHRINK_ABOVE_BYTES = 300 * 1024;

/**
 * Shrink a photo before upload. A phone photo is several megabytes and the
 * stored picture is 256 pixels square, so sending the original wastes the
 * client's data and risks the action's body limit. The server still checks
 * and re-encodes whatever arrives; this is a convenience, not a control.
 */
async function shrinkForUpload(file: File): Promise<File> {
  if (file.size <= SHRINK_ABOVE_BYTES || !/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, SEND_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.9),
    );
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

export function PictureForm({ hasPicture, readOnly }: { hasPicture: boolean; readOnly: boolean }) {
  const [upload, uploadAction, uploading] = useActionState<ProfileActionResult | null, FormData>(
    uploadAvatarAction,
    null,
  );
  const [removal, removeAction, removing] = useActionState<ProfileActionResult | null, void>(
    removeAvatarAction,
    null,
  );
  const [chosen, setChosen] = useState<string | null>(null);
  // Which of the two last ran, so its answer is the one shown.
  const [last, setLast] = useState<"upload" | "remove">("upload");

  // The shrink is awaited first, so the dispatch happens after the form's
  // own transition has ended; it needs one of its own for `pending` to track it.
  async function submit(formData: FormData) {
    const file = formData.get("avatar");
    if (file instanceof File && file.size > 0) formData.set("avatar", await shrinkForUpload(file));
    setLast("upload");
    startTransition(() => uploadAction(formData));
  }

  return (
    <div>
      <form action={submit} className="profile-picture-form">
        <label htmlFor="avatar" className="sr-only">
          Choose a picture
        </label>
        <input
          id="avatar"
          name="avatar"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          disabled={readOnly || uploading}
          onChange={(event) => setChosen(event.target.files?.[0]?.name ?? null)}
        />
        <button type="submit" className="secondary small" disabled={readOnly || uploading || !chosen}>
          {uploading ? "Saving…" : hasPicture ? "Replace picture" : "Add picture"}
        </button>
        {hasPicture && (
          <button
            type="button"
            className="secondary small"
            disabled={readOnly || removing}
            onClick={() => {
              setLast("remove");
              startTransition(() => removeAction());
            }}
          >
            {removing ? "Removing…" : "Remove"}
          </button>
        )}
      </form>
      <p className="field-hint">
        {readOnly ? READ_ONLY_HINT : "A square crop of the middle of the photo, shown beside your name."}
      </p>
      <Outcome state={last === "remove" ? removal : upload} />
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

  return (
    <form action={formAction} noValidate>
      <div className="profile-details-grid">
        <div>
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
        <div>
          <label htmlFor="details-email">Email</label>
          <input
            id="details-email"
            name="email"
            type="email"
            autoComplete="email"
            defaultValue={values.email}
            disabled={readOnly || pending}
            aria-invalid={errors.email ? true : undefined}
            aria-describedby="details-email-hint"
          />
          <p className="field-hint" id="details-email-hint">
            Where we write to you, and what you sign in with.
          </p>
          {errors.email && <p className="error">{errors.email}</p>}
        </div>
        <div className="is-wide">
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
            Only needed to change your email. To change the password itself, go to{" "}
            <Link href="/change-password">Change your password</Link>.
          </p>
          {errors.currentPassword && <p className="error">{errors.currentPassword}</p>}
        </div>
      </div>
      <Outcome state={state} />
      <div className="actions" style={{ marginTop: "1rem" }}>
        <button type="submit" disabled={readOnly || pending}>
          {pending ? "Saving…" : "Save your details"}
        </button>
        {readOnly && <span className="muted">{READ_ONLY_HINT}</span>}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// General information about the business
// ---------------------------------------------------------------------------

export function BusinessForm({
  details,
  readOnly,
}: {
  details: Record<string, string>;
  readOnly: boolean;
}) {
  const [state, formAction, pending] = useActionState<ProfileActionResult | null, FormData>(
    saveBusinessAction,
    null,
  );
  // A refused save shows what was typed, not what was stored.
  const values = state?.values ?? details;

  return (
    <form action={formAction} className="profile-form" noValidate>
      {PROFILE_GROUPS.map((group) => (
        <fieldset key={group} className="profile-group" disabled={readOnly || pending}>
          <legend>{group}</legend>
          <div className="profile-grid">
            {PROFILE_FIELDS.filter((f) => f.group === group).map((field) => (
              <BusinessProfileField
                key={field.key}
                field={field}
                value={values[field.key] ?? ""}
                error={state?.errors?.[field.key]}
              />
            ))}
          </div>
        </fieldset>
      ))}
      <Outcome state={state} />
      <div className="actions">
        <button type="submit" disabled={readOnly || pending}>
          {pending ? "Saving…" : "Save business information"}
        </button>
        {readOnly && <span className="muted">{READ_ONLY_HINT}</span>}
      </div>
    </form>
  );
}
