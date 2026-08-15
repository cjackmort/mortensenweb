import type { EmailMessage } from "./mailer";
import type { DunningStage } from "@/lib/billing/dunning";
import { formatCurrency } from "@/lib/payments/venmo";

/**
 * Payment reminders.
 *
 * The tone escalates across the ladder but never becomes threatening, and no
 * rung ever suggests the website will be taken down — because it will not be.
 * Overstating the consequence to apply pressure would be a lie the product
 * cannot carry out, and a small contractor reading "your site will go offline"
 * about a $150 invoice will panic rather than pay faster.
 *
 * Every message states what is owed, how to pay, and what actually happens
 * next.
 */

export interface PaymentReminderInput {
  stage: Exclude<DunningStage, "none">;
  businessName: string;
  contactName: string | null;
  amountCents: number;
  reference: string;
  dueOn: Date;
  daysOverdue: number;
  portalUrl: string;
}

interface StageCopy {
  subject: string;
  opening: string;
  consequence: string;
}

function copyFor(input: PaymentReminderInput): StageCopy {
  const amount = formatCurrency(input.amountCents);

  switch (input.stage) {
    case "first_reminder":
      return {
        subject: `Invoice ${input.reference} — ${amount} due`,
        opening: `Just a nudge that your ${amount} invoice was due on ${formatDate(input.dueOn)}. If you have already sent it across, thank you — ignore this and it will clear once we have matched it up.`,
        consequence:
          "Nothing changes on your site. We will keep working as normal.",
      };
    case "second_reminder":
      return {
        subject: `Invoice ${input.reference} — still outstanding`,
        opening: `Your ${amount} invoice is now ${input.daysOverdue} days past due. If something has gone wrong or the timing is difficult, reply and we will sort out a plan — that is genuinely easier for both of us than letting it drift.`,
        consequence:
          "Your site stays live and we are still working on it. If this remains unpaid we will pause new work, which we would rather avoid.",
      };
    case "final_notice":
      return {
        subject: `Invoice ${input.reference} — new work pausing soon`,
        opening: `Your ${amount} invoice is ${input.daysOverdue} days past due. This is the last reminder before we pause new work on your site.`,
        consequence:
          "To be clear about what this does and does not mean: your website stays online and keeps working. What pauses is new change requests and updates from us. Everything resumes as soon as the invoice clears.",
      };
    case "management_paused":
      return {
        subject: `Invoice ${input.reference} — new work is now paused`,
        opening: `We have paused new work on your site while your ${amount} invoice remains outstanding.`,
        consequence:
          "Your website is still online and will stay online. We are simply not taking new change requests until this is settled. Pay the invoice and we will pick straight back up — nothing is lost.",
      };
  }
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: process.env.BUSINESS_TIMEZONE ?? "America/Denver",
  });
}

export function buildPaymentReminderEmail(
  input: PaymentReminderInput,
): EmailMessage {
  const copy = copyFor(input);
  const greeting = input.contactName ? `Hi ${input.contactName},` : "Hi there,";
  const billingUrl = `${input.portalUrl.replace(/\/$/, "")}/billing`;
  const amount = formatCurrency(input.amountCents);

  const text = `${greeting}

${copy.opening}

  Invoice:   ${input.reference}
  Amount:    ${amount}
  Due:       ${formatDate(input.dueOn)}

Pay here: ${billingUrl}

${copy.consequence}

If you think this is a mistake, or you have already paid, just reply to this
email and we will look into it.

— Mortensen Web Co.`;

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c1917;line-height:1.6">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
<p style="margin:0 0 16px">${greeting}</p>
<p style="margin:0 0 24px">${escapeHtml(copy.opening)}</p>
<table style="width:100%;border-collapse:collapse;background:#fafaf9;border-radius:8px;margin:0 0 24px">
  <tr><td style="padding:14px 16px 4px;font-size:13px;color:#78716c">Invoice</td><td style="padding:14px 16px 4px;text-align:right;font-family:ui-monospace,monospace;font-weight:600">${escapeHtml(input.reference)}</td></tr>
  <tr><td style="padding:0 16px 4px;font-size:13px;color:#78716c">Amount</td><td style="padding:0 16px 4px;text-align:right;font-weight:600">${escapeHtml(amount)}</td></tr>
  <tr><td style="padding:0 16px 14px;font-size:13px;color:#78716c">Due</td><td style="padding:0 16px 14px;text-align:right">${escapeHtml(formatDate(input.dueOn))}</td></tr>
</table>
<div style="text-align:center;margin:0 0 24px">
  <a href="${billingUrl}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600">Pay invoice</a>
</div>
<p style="margin:0 0 24px;font-size:14px;color:#57534e">${escapeHtml(copy.consequence)}</p>
<hr style="border:none;border-top:1px solid #e7e5e4;margin:0 0 20px">
<p style="margin:0;font-size:14px;color:#57534e">If you think this is a mistake, or you have already paid, just reply to this email and we will look into it.</p>
<p style="margin:16px 0 0;font-size:14px">&mdash; Mortensen Web Co.</p>
</div></body></html>`;

  return { to: "", subject: copy.subject, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
