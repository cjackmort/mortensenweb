import { isEmailAddress } from "@/lib/growth/lead-reply";

/**
 * A customer's email and phone, in the one form they are stored and compared
 * in. The suppression list and the "already asked" check both match on these,
 * so "Dana@Example.com" and "dana@example.com" must be the same person, and so
 * must "(801) 555-0123" and "+18015550123".
 */

export function normalizeEmail(raw: string | null | undefined): string | null {
  const value = raw?.trim().toLowerCase() ?? "";
  return isEmailAddress(value) ? value : null;
}

/**
 * E.164, assuming a US number when there is no country code — every client is
 * a US business texting local customers. A number with a leading `+` is taken
 * as already international.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  const value = raw?.trim() ?? "";
  if (!value || /[a-z]/i.test(value)) return null;
  const digits = value.replace(/\D/g, "");

  if (value.startsWith("+")) {
    return digits.length >= 8 && digits.length <= 15 && !digits.startsWith("0") ? `+${digits}` : null;
  }
  if (digits.length === 10 && /^[2-9]/.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1") && /^[2-9]/.test(digits.slice(1))) return `+${digits}`;
  return null;
}

/** "Dana Reyes" → "Dana". Written as typed: a business that wrote "dana" meant it. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}
