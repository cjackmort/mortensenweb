import type { MarkListingStepInput } from "./checklist";

const text = (form: FormData, name: string) => String(form.get(name) ?? "");

/**
 * The checklist form's three buttons, as the repository's input. "Mark done"
 * and "Mark not done" carry the note along so a link typed and then ticked
 * is not lost; "Save note" leaves the state alone.
 */
export function listingInputFromForm(form: FormData): MarkListingStepInput {
  const intent = text(form, "intent");
  const note = text(form, "note");
  const stepKey = text(form, "stepKey");
  if (intent === "done") return { stepKey, done: true, note };
  if (intent === "todo") return { stepKey, done: false, note };
  return { stepKey, note };
}
