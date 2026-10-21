import type { EmailMessage } from "@/lib/email/mailer";
import { fromHeader } from "@/lib/growth/lead-reply";
import { firstName } from "./contact";
import { renderTemplate } from "./template";

/**
 * The review request as the customer receives it.
 *
 * Sent the way lead replies are (see `lib/growth/lead-reply.ts`): from our
 * verified domain under the business's name, with the business's own address
 * as Reply-To, so a customer who answers reaches the business. No Bcc: a copy
 * of every request in the client's inbox would be noise, and the dashboard is
 * their record.
 *
 * Plain on purpose. One link to Google, styled as a button but still a plain
 * link, and nothing that asks how the customer felt first — that would be
 * review gating (see `template.ts`).
 *
 * The unsubscribe line and the `List-Unsubscribe` headers are always added,
 * whatever the template says. Gmail and Yahoo require one-click unsubscribe
 * from bulk senders, and a customer asking a business to stop must always find
 * the way to.
 */

export interface ReviewEmailInput {
  to: string;
  customerName: string;
  businessName: string;
  senderAddress: string;
  replyTo: string | null;
  /** From General information, when the business has a public address. */
  postalAddress: string | null;
  template: { subject: string; body: string };
  reviewLink: string;
  /** The page a person lands on from the unsubscribe line. */
  stopLink: string;
  /** Where a mail provider's one-click unsubscribe POSTs. */
  unsubscribePost: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function oneLine(value: string, max: number): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function buildReviewEmail(input: ReviewEmailInput): EmailMessage {
  const values = { name: input.customerName, business: input.businessName };
  const subject = oneLine(renderTemplate(input.template.subject, values), 150);
  const body = renderTemplate(input.template.body, values).replace(/\r\n?/g, "\n").trim();
  const business = oneLine(input.businessName, 80);
  const address = input.postalAddress ? oneLine(input.postalAddress, 200) : null;

  const footer = [
    `You are getting this because you are a customer of ${business}.${address ? ` ${address}` : ""}`,
    `Don't want review requests from ${business}? Unsubscribe: ${input.stopLink}`,
  ];

  const text = [body, "", "Leave a review on Google:", input.reviewLink, "", "—", ...footer].join("\n");

  const html = `<!doctype html><html><body style="margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;font-size:15px;line-height:1.55">
<div style="max-width:600px;padding:16px">
<div style="white-space:pre-wrap">${escapeHtml(body)}</div>
<p style="margin:24px 0"><a href="${escapeHtml(input.reviewLink)}" style="display:inline-block;padding:12px 20px;background:#1a73e8;color:#fff;text-decoration:none;border-radius:4px;font-weight:600">Leave a review on Google</a></p>
<p style="margin:0 0 24px;color:#555;font-size:13px">Or open this link: <a href="${escapeHtml(input.reviewLink)}" style="color:#1a73e8">${escapeHtml(input.reviewLink)}</a></p>
<p style="margin:0;color:#777;font-size:12px;border-top:1px solid #eee;padding-top:12px">You are getting this because you are a customer of ${escapeHtml(business)}.${address ? ` ${escapeHtml(address)}` : ""}<br>Don't want review requests from ${escapeHtml(business)}? <a href="${escapeHtml(input.stopLink)}" style="color:#777">Unsubscribe</a></p>
</div></body></html>`;

  return {
    to: input.to,
    from: fromHeader(input.businessName, input.senderAddress),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    subject,
    text,
    html,
    headers: {
      "List-Unsubscribe": `<${input.unsubscribePost}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

/**
 * The text-message version: fixed wording, because a text has to name the
 * business up front, fit in about two segments and say how to stop, and an
 * editable one would lose one of the three sooner or later.
 */
export function buildReviewSms(input: {
  customerName: string;
  businessName: string;
  reviewLink: string;
  reminder: boolean;
}): string {
  const business = oneLine(input.businessName, 40);
  const name = firstName(oneLine(input.customerName, 40));
  const ask = input.reminder
    ? "a quick reminder: if you have a minute, an honest Google review would mean a lot."
    : "thanks for choosing us. Would you leave an honest review on Google?";
  return `${business}: Hi ${name}, ${ask} ${input.reviewLink} Reply STOP to opt out.`;
}
