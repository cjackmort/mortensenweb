"use client";

import { startTransition, useActionState, useRef, useState } from "react";
import { removeAvatarAction, uploadAvatarAction, type ProfileActionResult } from "./actions";
import { ACCEPTED_TYPES, checkChosenFile } from "./crop";
import { CropDialog } from "./crop-dialog";

/**
 * The picture at the top of the profile, and how it is changed.
 *
 * No file field on the page: the picture itself is the button. A pencil sits
 * on its corner (always, so a phone has something to tap; hover darkens the
 * picture and says "Change"), it opens the file picker, and the chosen
 * photo opens in a dialog to be positioned before anything is sent. The
 * upload is the existing action, so the server's checks and re-encoding are
 * unchanged.
 */

interface AvatarEditorProps {
  /** The current picture or initials (`UserAvatar`, rendered by the page). */
  children: React.ReactNode;
  hasPicture: boolean;
  readOnly: boolean;
}

export function AvatarEditor({ children, hasPicture, readOnly }: AvatarEditorProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Which of the two last ran, so its answer is the one shown.
  const [last, setLast] = useState<"upload" | "remove" | null>(null);

  function closeDialog() {
    if (src) URL.revokeObjectURL(src);
    setSrc(null);
  }

  const [upload, uploadAction, uploading] = useActionState<ProfileActionResult | null, FormData>(
    async (previous, formData) => {
      let result: ProfileActionResult;
      try {
        result = await uploadAvatarAction(previous, formData);
      } catch {
        // The request itself failed — offline, or the server fell over. Said
        // in the dialog, which stays open with the photo still positioned.
        result = { ok: false, message: "Your photo couldn't be sent. Check your connection and try again." };
      }
      if (result.ok) {
        closeDialog();
      } else {
        setSaveError(result.message);
      }
      return result;
    },
    null,
  );
  const [removal, removeAction, removing] = useActionState<ProfileActionResult | null, void>(
    removeAvatarAction,
    null,
  );

  /** Open a chosen file in the dialog, or say why it cannot be used. */
  function open(file: File): string | null {
    const refused = checkChosenFile(file);
    if (refused) return refused;
    setSaveError(null);
    if (src) URL.revokeObjectURL(src);
    setSrc(URL.createObjectURL(file));
    return null;
  }

  function chosen(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Cleared so choosing the same file again still fires a change.
    event.target.value = "";
    if (!file) return;
    setProblem(open(file));
  }

  function save(picture: Blob) {
    const extension = picture.type === "image/webp" ? "webp" : "jpg";
    const formData = new FormData();
    formData.set("avatar", new File([picture], `avatar.${extension}`, { type: picture.type }));
    setSaveError(null);
    setLast("upload");
    startTransition(() => uploadAction(formData));
  }

  function remove() {
    setConfirmRemove(false);
    setLast("remove");
    startTransition(() => removeAction());
  }

  const outcome = last === "remove" ? removal : last === "upload" && upload?.ok ? upload : null;

  return (
    <div className="avatar-editor">
      <button
        ref={buttonRef}
        type="button"
        className="avatar-button"
        onClick={() => inputRef.current?.click()}
        // Not disabled while uploading: the dialog covers the page then, and
        // focus has to come back to this button when it closes.
        disabled={readOnly || removing}
        aria-label={hasPicture ? "Change your profile photo" : "Add a profile photo"}
      >
        {children}
        <span className="avatar-button-veil" aria-hidden="true">
          {hasPicture ? "Change" : "Add photo"}
        </span>
        {!readOnly && (
          <span className="avatar-button-badge" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="14" height="14" focusable="false">
              <path
                d="M11.1 2.3a1.6 1.6 0 0 1 2.3 0l.3.3a1.6 1.6 0 0 1 0 2.3L6 12.6 2.5 13.5l.9-3.5 7.7-7.7Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_TYPES.join(",")}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={chosen}
      />

      {hasPicture && !readOnly && (
        <div className="avatar-remove">
          {confirmRemove ? (
            <>
              <span>Remove your photo?</span>
              <button type="button" className="linklike" onClick={remove}>
                Remove
              </button>
              <button type="button" className="linklike avatar-keep" onClick={() => setConfirmRemove(false)}>
                Keep it
              </button>
            </>
          ) : (
            <button
              type="button"
              className="linklike"
              onClick={() => setConfirmRemove(true)}
              disabled={removing || uploading}
            >
              {removing ? "Removing…" : "Remove photo"}
            </button>
          )}
        </div>
      )}

      <div className="avatar-outcome" role="status">
        {problem && <p className="error">{problem}</p>}
        {!problem && outcome && <p className={outcome.ok ? "avatar-saved" : "error"}>{outcome.message}</p>}
      </div>

      {src && (
        <CropDialog
          src={src}
          saving={uploading}
          error={saveError}
          onSave={save}
          onCancel={closeDialog}
          onChooseAnother={open}
          returnFocusTo={buttonRef}
        />
      )}
    </div>
  );
}
