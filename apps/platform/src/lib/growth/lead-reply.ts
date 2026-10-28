import type { EmailMessage } from "@/lib/email/mailer";

/**
 * Replying to a lead from the portal, without the client's mailbox.
 *
 * The reply goes out through Resend, which can only send from a domain we have
 * verified — so it cannot come from `smithplumbing@gmail.com`, and pretending
 * otherwise would fail Gmail's own sender checks and land in spam. Instead:
 *
 *   From:     "Smith Plumbing" <replies@our-domain>   — the business's name
 *   Reply-To: the client's own address                — answers go to them
 *   Bcc:      the client's own address                — their record of it
 *
 * To the customer it reads as a message from the business they wrote to, and
 * the conversation carries on in the client's normal inbox. Connecting Gmail
 * would buy the client's address in the From line at the cost of a Google
 * security review and a second integration for every other mail provider.
 *
 * The other way, and the one the form offers first, needs none of that: the
 * same words as a draft in the client's own email app (`mailto:`) or in Gmail
 * on the web, addressed and quoted, for them to press send on. It then goes
 * from their own address, and nothing here has to be configured or trusted.
 * The portal cannot know whether they sent it, so it records nothing — the
 * status buttons on the enquiry are where they say they did.
 */

export const MAX_REPLY_LENGTH = 5000;
/** Per organization, per hour. Generous for a business; a ceiling on a stolen session. */
export const REPLIES_PER_HOUR = 30;

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function isEmailAddress(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length <= 254 && EMAIL.test(value);
}

/**
 * The bare address replies are sent from.
 *
 * `LEADS_REPLY_FROM_ADDRESS` when set; otherwise the address inside
 * `RESEND_FROM_ADDRESS` (`"Mortensen Web Co." <hello@…>` → `hello@…`), which is
 * already on a verified domain. Null when neither is usable, and the caller
 * refuses rather than guessing.
 */
export function replySenderAddress(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const explicit = env.LEADS_REPLY_FROM_ADDRESS?.trim();
  if (explicit && isEmailAddress(explicit)) return explicit;

  const configured = env.RESEND_FROM_ADDRESS?.trim() ?? "";
  const bracketed = configured.match(/<([^>]+)>/);
  const address = (bracketed ? bracketed[1] : configured)?.trim();
  return address && isEmailAddress(address) ? address : null;
}

/**
 * `"Smith Plumbing" <replies@…>`.
 *
 * The name comes from the business profile, which a client can edit, so it is
 * reduced to something that cannot break out of the header: no quotes, angle
 * brackets, backslashes or line breaks, and short enough to read.
 */
export function fromHeader(businessName: string, address: string): string {
  const name =
    businessName
      .replace(/[\r\n\t]+/g, " ")
      .replace(/["<>\\]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || "Your enquiry";
  return `"${name}" <${address}>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function subjectSafe(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 80);
}

export interface LeadReplyInput {
  businessName: string;
  senderAddress: string;
  /** Where the customer's answer goes: the business's own email. */
  replyTo: string;
  /** The customer. */
  to: string;
  body: string;
  /** What the customer originally wrote, quoted underneath for context. */
  original: { message: string | null; receivedOn: string } | null;
}

/** The subject line every reply carries, however it is sent. */
export function replySubject(businessName: string): string {
  return `Re: Your enquiry to ${subjectSafe(businessName)}`;
}

type Original = { message: string | null; receivedOn: string } | null;

function normaliseBody(body: string): string {
  return body.replace(/\r\n?/g, "\n").trim();
}

/** What the customer wrote, quoted under the reply. Empty when there is nothing to quote. */
function quotedLines(original: Original): string[] {
  const quoted = original?.message ? normaliseBody(original.message) : null;
  if (!quoted) return [];
  return ["", `On ${original!.receivedOn}, you wrote:`, ...quoted.split("\n").map((l) => `> ${l}`)];
}

export interface MailDraftInput {
  /** The customer. */
  to: string;
  businessName: string;
  /** What the client has typed so far. May be empty: the draft still carries the quote. */
  body: string;
  original: Original;
}

export interface MailDraft {
  to: string;
  subject: string;
  body: string;
}

/**
 * The reply as a draft for the client's own email app: the same subject and
 * quoted original the portal would send, with their words above it.
 */
export function buildMailDraft(input: MailDraftInput): MailDraft {
  return {
    to: input.to,
    subject: replySubject(input.businessName),
    body: [normaliseBody(input.body), ...quotedLines(input.original)].join("\n"),
  };
}

/**
 * A `mailto:` link that opens the draft in whatever handles email on the
 * device — the Gmail app on most phones, Outlook or Mail on a desktop.
 *
 * RFC 6068: everything percent-encoded, line breaks as CRLF. `encodeURIComponent`
 * leaves `'()*!` alone, which is fine inside a mailto but not inside an
 * attribute a template might quote with single quotes, so they go too.
 */
export function mailtoHref(draft: MailDraft): string {
  const body = draft.body.replace(/\n/g, "\r\n");
  return `mailto:${encode(draft.to)}?subject=${encode(draft.subject)}&body=${encode(body)}`;
}

/**
 * The same draft in Gmail on the web, for a client who reads mail in a
 * browser tab, where a `mailto:` link may open nothing at all.
 */
export function gmailComposeHref(draft: MailDraft): string {
  const params = new URLSearchParams({
    view: "cm",
    fs: "1",
    to: draft.to,
    su: draft.subject,
    body: draft.body,
  });
  return `https://mail.google.com/mail/?${params.toString()}`;
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function buildLeadReplyEmail(input: LeadReplyInput): EmailMessage {
  const subject = replySubject(input.businessName);
  const body = normaliseBody(input.body);
  const quoted = input.original?.message ? normaliseBody(input.original.message) : null;

  const text = [body, ...quotedLines(input.original)].join("\n");

  // Deliberately plain: this is the business writing to its customer, and an
  // email that looks like a marketing template reads as one — and filters as
  // one. No logo, no button, no tracking.
  const html = `<!doctype html><html><body style="margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;font-size:15px;line-height:1.55">
<div style="max-width:600px;padding:16px">
<div style="white-space:pre-wrap">${escapeHtml(body)}</div>
${
  quoted
    ? `<p style="margin:24px 0 6px;color:#666;font-size:13px">On ${escapeHtml(input.original!.receivedOn)}, you wrote:</p>
<blockquote style="margin:0;padding:0 0 0 12px;border-left:3px solid #ddd;color:#555;white-space:pre-wrap">${escapeHtml(quoted)}</blockquote>`
    : ""
}
</div></body></html>`;

  return {
    to: input.to,
    from: fromHeader(input.businessName, input.senderAddress),
    replyTo: input.replyTo,
    bcc: input.replyTo,
    subject,
    text,
    html,
  };
}
