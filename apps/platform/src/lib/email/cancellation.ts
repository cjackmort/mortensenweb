import type { EmailMessage } from "./mailer";

/**
 * The confirmation a client gets after cancelling their plan or an add-on.
 *
 * Proof they cancelled, which is what click-to-cancel rules expect and what a
 * client checks when the next card statement arrives: what ended, the date it
 * stops, that nothing more will be charged for it, and how to change their
 * mind before then. The undo is a link to the Plan tab, not a token: undoing
 * puts a charge back, so it happens signed in.
 */

export interface CancellationEmailInput {
  contactName: string | null;
  /** "Care plan", "Review requests". */
  what: string;
  /** Whether the whole plan ended, which takes the add-ons with it. */
  wholePlan: boolean;
  /** Null when Stripe did not say; the email then names the period instead. */
  endsOn: Date | null;
  planUrl: string;
}

function longDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: process.env.BUSINESS_TIMEZONE ?? "America/Denver",
  });
}

export function buildCancellationEmail(input: CancellationEmailInput): EmailMessage {
  const greeting = input.contactName ? `Hi ${input.contactName},` : "Hi there,";
  const ends = input.endsOn ? longDate(input.endsOn) : "the end of the period you've paid for";
  const after = input.wholePlan
    ? "Your website stays online. Changes and Growth tools stop then, along with any add-ons."
    : "Everything else on your plan carries on as before.";

  const text = `${greeting}

You cancelled ${input.what}. It keeps working until ${ends}, and you won't be charged for it again.

${after}

Changed your mind? Undo it from the Plan tab any time before then:

${input.planUrl}

— Mortensen Web Co.`;

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c1917;line-height:1.6">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
<p style="margin:0 0 16px">${escapeHtml(greeting)}</p>
<p style="margin:0 0 16px">You cancelled <strong>${escapeHtml(input.what)}</strong>. It keeps working until <strong>${escapeHtml(ends)}</strong>, and you won&rsquo;t be charged for it again.</p>
<p style="margin:0 0 24px">${escapeHtml(after)}</p>
<p style="margin:0 0 8px;font-weight:600">Changed your mind?</p>
<p style="margin:0 0 24px">Undo it from the <a href="${escapeHtml(input.planUrl)}" style="color:#1c1917">Plan tab</a> any time before then.</p>
<p style="margin:0;font-size:14px">&mdash; Mortensen Web Co.</p>
</div></body></html>`;

  const short = input.endsOn
    ? `, ends ${input.endsOn.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: process.env.BUSINESS_TIMEZONE ?? "America/Denver" })}`
    : "";
  return { to: "", subject: `Cancelled: ${input.what}${short}`, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
