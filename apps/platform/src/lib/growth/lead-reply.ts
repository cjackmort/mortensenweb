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

export function buildLeadReplyEmail(input: LeadReplyInput): EmailMessage {
  const subject = `Re: Your enquiry to ${subjectSafe(input.businessName)}`;
  const body = input.body.replace(/\r\n?/g, "\n").trim();
  const quoted = input.original?.message
    ? input.original.message.replace(/\r\n?/g, "\n").trim()
    : null;

  const text = [
    body,
    ...(quoted
      ? ["", `On ${input.original!.receivedOn}, you wrote:`, ...quoted.split("\n").map((l) => `> ${l}`)]
      : []),
  ].join("\n");

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
