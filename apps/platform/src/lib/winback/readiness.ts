import { profileFieldHref, type BusinessDetails } from "@/lib/business-profile";
import { isEmailAddress, replySenderAddress } from "@/lib/growth/lead-reply";

/**
 * Whether a win-back campaign may go out, and what is missing when not.
 *
 * Checked at approval and again before every batch, because General
 * information can change in between. Each gap is named so the page can say
 * exactly what to do about it — "add your postal address" — rather than a
 * generic "cannot send".
 */

export type Missing =
  /** CAN-SPAM requires a valid postal address in every commercial email. */
  | "postal_address"
  /** Somewhere for a customer's reply to go. */
  | "reply_to"
  /** No verified sending address on this server. */
  | "sender"
  /** No secret to sign unsubscribe links with, or no address to put in them. */
  | "links";

export const MISSING_MESSAGE: Record<Missing, string> = {
  postal_address:
    "Your business's postal address is missing from your profile. US law (CAN-SPAM) requires one in every marketing email; a PO box is fine.",
  reply_to: "There's no email address for your customers' replies to go to. Add your business email to your profile.",
  sender: "Sending isn't switched on for this portal yet. We'll let you know when it is.",
  links: "Unsubscribe links can't be made on this portal yet. We'll let you know when it is.",
};

/**
 * The gaps the client can close themselves, and the profile field that
 * closes each one. The address is the profile's `address`; replies go to the
 * profile's public `email` (see `sendingReadiness`), so that is the field to
 * fill when there is nowhere for them to go. The other two are ours.
 */
export const MISSING_FIX: Partial<Record<Missing, { href: string; label: string }>> = {
  postal_address: { href: profileFieldHref("address"), label: "Add your address" },
  reply_to: { href: profileFieldHref("email"), label: "Add a business email" },
};

/**
 * The bare address win-back email is sent from: `WINBACK_FROM_ADDRESS`, so
 * marketing can go from its own subdomain and keep the portal's own mail's
 * reputation apart, else the address lead replies use.
 */
export function winbackSenderAddress(env: Record<string, string | undefined> = process.env): string | null {
  const own = env.WINBACK_FROM_ADDRESS?.trim();
  if (own && isEmailAddress(own)) return own;
  return replySenderAddress(env);
}

export interface Readiness {
  ready: boolean;
  missing: Missing[];
  replyTo: string | null;
  postalAddress: string | null;
}

export function sendingReadiness(input: {
  details: BusinessDetails | null | undefined;
  /** The signed-in person's own address, when the profile has no public one. */
  fallbackReplyTo: string | null | undefined;
  env?: Record<string, string | undefined>;
}): Readiness {
  const env = input.env ?? process.env;
  const details = input.details ?? {};
  const postalAddress = details.address?.trim() || null;
  const profileEmail = details.email?.trim();
  const replyTo = isEmailAddress(profileEmail)
    ? profileEmail
    : isEmailAddress(input.fallbackReplyTo)
      ? input.fallbackReplyTo
      : null;

  const missing: Missing[] = [];
  if (!postalAddress) missing.push("postal_address");
  if (!replyTo) missing.push("reply_to");
  if (!winbackSenderAddress(env)) missing.push("sender");
  if (!env.AUTH_SECRET || !(env.AUTH_URL ?? env.NEXT_PUBLIC_SITE_URL)) missing.push("links");

  return { ready: missing.length === 0, missing, replyTo, postalAddress };
}

/** Scheduled sends go at this hour, the business's time: the start of a working day. */
export const SEND_HOUR = 9;

function offsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return (wall - at.getTime()) / 60_000;
}

/** `2026-10-28` → 9am that day in `timeZone`, as an instant. Null for anything else. */
export function sendTimeFor(day: string, timeZone: string): Date | null {
  const match = day.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const naive = Date.UTC(y, m - 1, d, SEND_HOUR);
  const check = new Date(naive);
  if (check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  // Twice, so a day the clocks change on lands on the right side of it.
  const first = naive - offsetMinutes(new Date(naive), timeZone) * 60_000;
  return new Date(naive - offsetMinutes(new Date(first), timeZone) * 60_000);
}
