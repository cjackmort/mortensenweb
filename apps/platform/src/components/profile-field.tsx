import type { ProfileField } from "@/lib/business-profile";

/**
 * One field of a business's general information, as the operator's form and
 * the client's own profile page both draw it: label, the input the field's
 * kind calls for, its hint, and the error against it when a save is refused.
 */
export function BusinessProfileField({
  field,
  value,
  error,
  suggested,
  highlighted,
}: {
  field: ProfileField;
  value: string;
  error?: string;
  /** Filled from their website and not yet saved. */
  suggested?: boolean;
  /** The field a link sent the reader to, picked out for a moment on arrival. */
  highlighted?: boolean;
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
    <div
      className={`${field.kind === "text" ? "profile-field profile-field-wide" : "profile-field"}${suggested ? " is-suggested" : ""}${highlighted ? " is-arrived" : ""}`}
    >
      <label htmlFor={id}>
        {field.label}
        {suggested && <span className="profile-suggested"> from their website, check before saving</span>}
      </label>
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
