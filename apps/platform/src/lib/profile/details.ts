import { z } from "zod";

/**
 * What a person can change about their own account: the name the portal
 * greets them by and the email they sign in with. The password has its own
 * page; the handle is issued by the operator and stays.
 */

export const MAX_NAME_LENGTH = 120;

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

const detailsSchema = z.object({
  name: z.string().trim().max(MAX_NAME_LENGTH, `Keep your name under ${MAX_NAME_LENGTH} characters.`),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Enter your email address.")
    .max(254, "That email address is too long.")
    .regex(EMAIL, "Enter an email address."),
  currentPassword: z.string(),
});

export interface OwnDetailsInput {
  name: string;
  email: string;
  currentPassword: string;
}

export type ParsedDetails =
  | { ok: true; input: OwnDetailsInput }
  | { ok: false; errors: Partial<Record<keyof OwnDetailsInput, string>> };

/** Read the details form. Whitespace is trimmed and the email lowercased, as the users table requires. */
export function parseDetailsForm(formData: FormData): ParsedDetails {
  const parsed = detailsSchema.safeParse({
    name: String(formData.get("name") ?? ""),
    email: String(formData.get("email") ?? ""),
    currentPassword: String(formData.get("currentPassword") ?? ""),
  });
  if (parsed.success) return { ok: true, input: parsed.data };

  const errors: Partial<Record<keyof OwnDetailsInput, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0] as keyof OwnDetailsInput | undefined;
    if (field && !errors[field]) errors[field] = issue.message;
  }
  return { ok: false, errors };
}
