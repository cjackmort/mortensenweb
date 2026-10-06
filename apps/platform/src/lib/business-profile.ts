import { z } from "zod";

/**
 * A business's general information: what its website says about it.
 *
 * Filled in once per client and attached by the portal to every agent run for
 * that client, so a brief or a change request never has to restate the phone
 * number, the hours or the service list — and an agent never has to guess
 * them. The agent is told to use these exactly as written, so the validation
 * here is what stands between a typo and the site's published phone number.
 *
 * Stored as one JSON object keyed by `key` (see `business_profiles.details`);
 * adding a field is a change to this list, not a migration.
 */

export type ProfileFieldKind = "line" | "text" | "url" | "email" | "phone";

export interface ProfileField {
  key: string;
  label: string;
  kind: ProfileFieldKind;
  group: ProfileGroup;
  hint?: string;
}

export const PROFILE_GROUPS = [
  "The business",
  "Contact",
  "What they offer",
  "Online",
  "Credentials",
  "Look and voice",
] as const;

export type ProfileGroup = (typeof PROFILE_GROUPS)[number];

export const PROFILE_FIELDS: readonly ProfileField[] = [
  { key: "businessName", label: "Business name", kind: "line", group: "The business", hint: "As customers see it, not the legal name unless they are the same." },
  { key: "tagline", label: "One-line description", kind: "line", group: "The business", hint: "What they do and where, in a sentence." },
  { key: "about", label: "About the business", kind: "text", group: "The business", hint: "Their story, who runs it, what makes them different." },
  { key: "founded", label: "Year founded", kind: "line", group: "The business" },

  { key: "phone", label: "Phone", kind: "phone", group: "Contact", hint: "The public number. Calls from the site go here." },
  { key: "email", label: "Email", kind: "email", group: "Contact", hint: "The public address. Enquiries from the site go here." },
  { key: "address", label: "Address", kind: "text", group: "Contact", hint: "Leave empty for a business without a public address." },
  { key: "hours", label: "Opening hours", kind: "text", group: "Contact", hint: "One line per day or range: Mon–Fri 8am–5pm." },
  { key: "bookingUrl", label: "Booking or quote link", kind: "url", group: "Contact", hint: "Where a \"Book now\" button should go." },

  { key: "services", label: "Services or products", kind: "text", group: "What they offer", hint: "One per line. Add a price after a dash if the site shows prices." },
  { key: "serviceArea", label: "Areas served", kind: "line", group: "What they offer", hint: "Towns, counties, or a radius." },
  { key: "payment", label: "Payment accepted", kind: "line", group: "What they offer" },

  { key: "website", label: "Current website", kind: "url", group: "Online" },
  { key: "googleBusiness", label: "Google Business Profile", kind: "url", group: "Online" },
  { key: "facebook", label: "Facebook", kind: "url", group: "Online" },
  { key: "instagram", label: "Instagram", kind: "url", group: "Online" },
  { key: "tiktok", label: "TikTok", kind: "url", group: "Online" },
  { key: "youtube", label: "YouTube", kind: "url", group: "Online" },
  { key: "linkedin", label: "LinkedIn", kind: "url", group: "Online" },
  { key: "yelp", label: "Yelp", kind: "url", group: "Online" },

  { key: "credentials", label: "Licences, certifications, insurance", kind: "text", group: "Credentials", hint: "Only what has been confirmed. The site will publish these as written." },
  { key: "awards", label: "Awards and memberships", kind: "text", group: "Credentials" },

  { key: "brand", label: "Colours, fonts and logo notes", kind: "text", group: "Look and voice" },
  { key: "voice", label: "Tone of voice", kind: "text", group: "Look and voice", hint: "How they talk, and words they would never use." },
  { key: "other", label: "Anything else the site should say", kind: "text", group: "Look and voice" },
];

const LIMITS: Record<ProfileFieldKind, number> = {
  line: 200,
  text: 4000,
  url: 500,
  email: 254,
  phone: 40,
};

const MIN_PHONE_DIGITS = 7;

function schemaFor(kind: ProfileFieldKind) {
  const bounded = z.string().max(LIMITS[kind], `Keep this under ${LIMITS[kind]} characters.`);

  switch (kind) {
    case "url":
      return bounded.refine((value) => {
        try {
          const url = new URL(value);
          return url.protocol === "https:" || url.protocol === "http:";
        } catch {
          return false;
        }
      }, "Enter a full web address, starting with https://.");
    case "email":
      return bounded.regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Enter an email address.");
    case "phone":
      return bounded
        .regex(/^[\d\s()+.-]+(?:\s*(?:ext\.?|x)\s*\d+)?$/i, "Enter a phone number.")
        .refine(
          (value) => value.replace(/\D/g, "").length >= MIN_PHONE_DIGITS,
          "Enter a phone number.",
        );
    default:
      return bounded;
  }
}

/** Short fields are one line on the page; a pasted line break is a mistake. */
function normalise(raw: string, kind: ProfileFieldKind): string {
  const unified = raw.replace(/\r\n?/g, "\n");
  const flattened = kind === "text" ? unified : unified.replace(/\s*\n\s*/g, " ");
  return flattened.trim();
}

export type BusinessDetails = Record<string, string>;

export type ParsedProfile =
  | { ok: true; details: BusinessDetails }
  | { ok: false; errors: Record<string, string>; details: BusinessDetails };

/**
 * Read the profile form. Only the known fields; empty answers are dropped so
 * clearing a field removes it rather than storing an empty string the agent
 * would read as "the business has no phone".
 */
export function parseProfileForm(formData: FormData): ParsedProfile {
  const details: BusinessDetails = {};
  const errors: Record<string, string> = {};

  for (const field of PROFILE_FIELDS) {
    const raw = formData.get(field.key);
    if (typeof raw !== "string") continue;

    const value = normalise(raw, field.kind);
    if (!value) continue;

    details[field.key] = value;
    const checked = schemaFor(field.kind).safeParse(value);
    if (!checked.success) {
      errors[field.key] = checked.error.issues[0]?.message ?? "Check this field.";
    }
  }

  return Object.keys(errors).length > 0
    ? { ok: false, errors, details }
    : { ok: true, details };
}

export interface ProfileEntry {
  key: string;
  label: string;
  value: string;
}

/** The filled-in fields, labelled, in the form's order. */
export function profileEntries(details: BusinessDetails | null | undefined): ProfileEntry[] {
  if (!details) return [];
  return PROFILE_FIELDS.flatMap((field) => {
    const value = details[field.key]?.trim();
    return value ? [{ key: field.key, label: field.label, value }] : [];
  });
}
