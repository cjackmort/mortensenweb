import type { EmailMessage } from "@/lib/email/mailer";
import { fromHeader } from "@/lib/growth/lead-reply";
import { formatAppointment } from "./format";

/**
 * The emails an appointment sends.
 *
 * To the customer, on every decision — confirmed (straight away, or when the
 * client approves), declined, cancelled — in the same envelope as a lead
 * reply: the business's name on our verified address, the business as
 * Reply-To and Bcc, so the customer answers the business and the business
 * keeps a copy. To the client, when a booking arrives, so a request that
 * needs approving is not left waiting for someone to open the portal.
 *
 * Nothing the customer typed reaches a header, and everything in the HTML is
 * escaped: the name and note come from a public form.
 */

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

function html(paragraphs: string[]): string {
  return `<!doctype html><html><body style="margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;font-size:15px;line-height:1.55">
<div style="max-width:600px;padding:16px">
${paragraphs.map((p) => `<p style="margin:0 0 14px">${p}</p>`).join("\n")}
</div></body></html>`;
}

export type CustomerEmailKind = "confirmed" | "declined" | "cancelled";

export interface CustomerEmailInput {
  kind: CustomerEmailKind;
  businessName: string;
  senderAddress: string;
  /** The business's own address: the customer's answer goes there. */
  replyTo: string;
  to: string;
  customerName: string;
  start: Date;
  timeZone: string;
  /** Booking public id: one email per booking and decision, however often a button is pressed. */
  bookingId: string;
}

export function buildCustomerEmail(input: CustomerEmailInput): EmailMessage {
  const business = oneLine(input.businessName, 60) || "We";
  const name = oneLine(input.customerName, 80);
  const when = formatAppointment(input.start, input.timeZone);
  const greeting = name ? `Hi ${name},` : "Hello,";

  const body: Record<CustomerEmailKind, { subject: string; lines: string[] }> = {
    confirmed: {
      subject: `Confirmed: ${when} with ${business}`,
      lines: [
        `You're booked with ${business} for ${when}.`,
        "If you need to change or cancel, reply to this email and it comes straight to us.",
      ],
    },
    declined: {
      subject: `${business} couldn't take your booking for ${when}`,
      lines: [
        `Sorry — ${business} can't fit you in on ${when}.`,
        "Please pick another time on our website, or reply to this email and we'll find one with you.",
      ],
    },
    cancelled: {
      subject: `Cancelled: ${when} with ${business}`,
      lines: [
        `Your appointment with ${business} on ${when} has been cancelled.`,
        "Reply to this email if you'd like to find another time.",
      ],
    },
  };
  const { subject, lines } = body[input.kind];

  return {
    to: input.to,
    from: fromHeader(business, input.senderAddress),
    replyTo: input.replyTo,
    bcc: input.replyTo,
    subject: oneLine(subject, 150),
    text: [greeting, "", ...lines.flatMap((l) => [l, ""]), business].join("\n"),
    html: html([escapeHtml(greeting), ...lines.map(escapeHtml), escapeHtml(business)]),
    idempotencyKey: `appointment-${input.bookingId}-${input.kind}`,
  };
}

export interface ClientNoticeInput {
  senderAddress: string;
  to: string;
  businessName: string;
  status: "pending" | "confirmed";
  customerName: string;
  customerEmail: string;
  customerPhone: string | null;
  note: string | null;
  start: Date;
  timeZone: string;
  /** The Availability page, where a request is approved or declined. */
  manageUrl: string | null;
  bookingId: string;
}

/** To the client: someone booked, or asked to. Reply-To is the customer, so answering reaches them. */
export function buildClientNotice(input: ClientNoticeInput): EmailMessage {
  const name = oneLine(input.customerName, 80);
  const when = formatAppointment(input.start, input.timeZone);
  const asked = input.status === "pending";
  const headline = asked ? `${name} asked to book ${when}.` : `${name} booked ${when}.`;
  const next = asked
    ? "It's held for them until you approve or decline it. They're emailed either way."
    : "It's confirmed, and they've been sent a confirmation.";
  const details = [
    `Email: ${input.customerEmail}`,
    ...(input.customerPhone ? [`Phone: ${input.customerPhone}`] : []),
    ...(input.note ? [`Note: ${oneLine(input.note, 1000)}`] : []),
  ];
  const link = input.manageUrl ? `${asked ? "Approve or decline it" : "See your bookings"}: ${input.manageUrl}` : null;

  return {
    to: input.to,
    from: fromHeader(`${oneLine(input.businessName, 40) || "Your"} bookings`, input.senderAddress),
    replyTo: input.customerEmail,
    subject: oneLine(asked ? `Booking request: ${name}, ${when}` : `New booking: ${name}, ${when}`, 150),
    text: [headline, next, "", ...details, ...(link ? ["", link] : [])].join("\n"),
    html: html([
      `<strong>${escapeHtml(headline)}</strong> ${escapeHtml(next)}`,
      details.map(escapeHtml).join("<br>"),
      ...(input.manageUrl
        ? [`<a href="${escapeHtml(input.manageUrl)}">${asked ? "Approve or decline it" : "See your bookings"}</a>`]
        : []),
    ]),
    idempotencyKey: `appointment-${input.bookingId}-notice`,
  };
}
