import type { EmailMessage } from "@/lib/email/mailer";
import { fromHeader } from "@/lib/growth/lead-reply";
import { featureTags } from "@/lib/email/tags";
import { formatDateWithYear } from "@/lib/time";

/**
 * One win-back email, as one past customer receives it.
 *
 * Sent the way lead replies are (see `lib/growth/lead-reply.ts`): from our
 * verified domain under the business's name, with the business's own address
 * as Reply-To, so an answer reaches the business and not us.
 *
 * What CAN-SPAM asks of a commercial email, and where each is met:
 *
 *  - **Who it is from**: the business's name in the From line, unaltered by
 *    anything the profile could inject (`fromHeader`).
 *  - **An honest subject**: written by the client, approved by the client.
 *  - **Says it is an ad**: "This is a promotional email" in the footer.
 *  - **A valid postal address**: in every footer. The caller refuses to
 *    approve or send without one; this builder never invents one.
 *  - **A way to opt out**: a link in the footer and a one-click
 *    `List-Unsubscribe` header (RFC 8058), honoured the moment it is used —
 *    well inside the ten business days the law allows.
 *
 * Deliberately plain, like the lead reply: a business writing to people who
 * know it. A heavy template reads as a newsletter and filters as one.
 */

export const LIMITS = { name: 80, subject: 120, body: 5000, offer: 200 } as const;

/** The tag that names the recipient row an email was for. */
export const RECIPIENT_TAG = "winback_recipient";

/** `{first_name}` in a draft becomes this, per customer. */
export const FIRST_NAME_TOKEN = "{first_name}";

export interface CampaignText {
  subject: string;
  body: string;
  offer: string | null;
  /** `YYYY-MM-DD`. */
  offerExpiresOn: string | null;
  fromName: string;
  replyTo: string;
  postalAddress: string;
}

export interface WinbackEmailInput {
  campaign: CampaignText;
  recipient: { publicId: string; email: string; name: string | null };
  /** For the tags that route Resend's webhooks back to this business. */
  organizationId: string;
  senderAddress: string;
  /** The page with the button: the footer link. */
  unsubscribeUrl: string;
  /** The endpoint mail apps POST to: the header. */
  oneClickUrl: string;
}

/** "Dana" from "Dana Reyes"; "there" for anything that is not plainly a name. */
export function firstNameFor(name: string | null | undefined): string {
  const first = name?.trim().split(/\s+/)[0] ?? "";
  if (!first || /[@\d<>]/.test(first) || first.length > 30) return "there";
  // An all-caps export ("ACME LLC") is a company, not a person.
  if (first.length > 2 && first === first.toUpperCase() && /[A-Z]/.test(first)) return "there";
  return first;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Plain web addresses in already-escaped text, as links. Trailing punctuation stays outside. */
function linkify(escaped: string): string {
  return escaped.replace(/https?:\/\/[^\s<]+/g, (match) => {
    const url = match.replace(/[.,;:!?)]+$/, "");
    const rest = match.slice(url.length);
    return `<a href="${url}" style="color:#1a56db">${url}</a>${rest}`;
  });
}

function subjectSafe(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, LIMITS.subject);
}

function offerLine(offer: string | null, expiresOn: string | null): string | null {
  const text = offer?.trim();
  if (!text) return null;
  if (!expiresOn) return text;
  // The end date is a sentence of its own, so the client's offer needs to end like one.
  return `${/[.!?]$/.test(text) ? text : `${text}.`} Ends ${formatDateWithYear(`${expiresOn}T12:00:00Z`)}.`;
}

export function buildWinbackEmail(input: WinbackEmailInput): EmailMessage {
  const { campaign, recipient } = input;
  const body = campaign.body
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(FIRST_NAME_TOKEN)
    .join(firstNameFor(recipient.name));
  const offer = offerLine(campaign.offer, campaign.offerExpiresOn);
  const address = campaign.postalAddress.replace(/\r\n?/g, "\n").trim();
  const addressOneLine = address.split("\n").map((l) => l.trim()).filter(Boolean).join(", ");
  const why = `You're getting this because you've been a customer of ${campaign.fromName}. This is a promotional email.`;

  const text = [
    body,
    ...(offer ? ["", `Offer: ${offer}`] : []),
    "",
    "--",
    `${campaign.fromName} · ${addressOneLine}`,
    why,
    `Unsubscribe: ${input.unsubscribeUrl}`,
  ].join("\n");

  const html = `<!doctype html><html><body style="margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;font-size:15px;line-height:1.55">
<div style="max-width:600px;padding:16px">
<div style="white-space:pre-wrap">${linkify(escapeHtml(body))}</div>
${
  offer
    ? `<p style="margin:20px 0 0;padding:12px 14px;border-left:3px solid #1a56db;background:#f3f6fd"><strong>Offer:</strong> ${escapeHtml(offer)}</p>`
    : ""
}
<p style="margin:32px 0 0;padding-top:12px;border-top:1px solid #e5e5e5;color:#666;font-size:12px;line-height:1.5">
${escapeHtml(campaign.fromName)} · ${escapeHtml(addressOneLine)}<br>
${escapeHtml(why)}<br>
<a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#666">Unsubscribe</a>
</p>
</div></body></html>`;

  return {
    to: recipient.email,
    from: fromHeader(campaign.fromName, input.senderAddress),
    replyTo: campaign.replyTo,
    subject: subjectSafe(campaign.subject),
    text,
    html,
    headers: {
      "List-Unsubscribe": `<${input.oneClickUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    idempotencyKey: `winback-${recipient.publicId}`,
    tags: featureTags("winback", input.organizationId, { [RECIPIENT_TAG]: recipient.publicId }),
  };
}

export interface CampaignTextInput {
  name: string;
  subject: string;
  body: string;
  offer: string;
  offerExpiresOn: string;
}

export type ValidatedText =
  | {
      ok: true;
      value: { name: string; subject: string; body: string; offer: string | null; offerExpiresOn: string | null };
    }
  | { ok: false; errors: Partial<Record<keyof CampaignTextInput, string>> };

/** What a client can save as a draft. Approval asks more of it; see `readiness.ts`. */
export function validateCampaignText(input: CampaignTextInput, now: Date): ValidatedText {
  const name = input.name.replace(/\s+/g, " ").trim();
  const subject = input.subject.replace(/\s+/g, " ").trim();
  const body = input.body.replace(/\r\n?/g, "\n").trim();
  const offer = input.offer.replace(/\s+/g, " ").trim();
  const expires = input.offerExpiresOn.trim();
  const errors: Partial<Record<keyof CampaignTextInput, string>> = {};

  if (name.length > LIMITS.name) errors.name = `Keep the name under ${LIMITS.name} characters.`;
  if (!subject) errors.subject = "Write a subject line.";
  else if (subject.length > LIMITS.subject) errors.subject = `Keep the subject under ${LIMITS.subject} characters.`;
  if (!body) errors.body = "Write the email.";
  else if (body.length > LIMITS.body) errors.body = `Keep the email under ${LIMITS.body} characters.`;
  if (offer.length > LIMITS.offer) errors.offer = `Keep the offer under ${LIMITS.offer} characters.`;

  let offerExpiresOn: string | null = null;
  if (offer && expires) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires) || Number.isNaN(Date.parse(`${expires}T00:00:00Z`))) {
      errors.offerExpiresOn = "Pick a date for the offer to end.";
    } else if (expires < now.toISOString().slice(0, 10)) {
      errors.offerExpiresOn = "That date has passed. Pick a later one, or clear it.";
    } else {
      offerExpiresOn = expires;
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { name: name || subject.slice(0, LIMITS.name), subject, body, offer: offer || null, offerExpiresOn } };
}
