import type { EmailMessage } from "./mailer";

/**
 * "Someone just filled in your contact form."
 *
 * Written to be acted on from a phone in a van: who it is, how to reach them,
 * what they said, and one link. Reply-to is the customer (set by the caller),
 * so pressing reply in the client's mail app answers the enquiry directly —
 * the fastest response path there is, and speed is most of what wins a lead.
 *
 * Every value in here was typed by a stranger into a public form, so all of it
 * is escaped before it touches the HTML body.
 */

export interface LeadReceivedInput {
  contactName: string | null;
  businessName: string;
  lead: {
    publicId: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    message: string | null;
  };
  portalUrl: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Subject lines are a single line, and some mail clients render whatever is in them. */
function subjectSafe(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 80);
}

const MESSAGE_LIMIT = 1200;

export function buildLeadReceivedEmail(input: LeadReceivedInput): EmailMessage {
  const { lead } = input;
  const who = lead.name ? subjectSafe(lead.name) : null;
  const link = `${input.portalUrl.replace(/\/$/, "")}/dashboard/growth/leads/${lead.publicId}`;
  const message =
    lead.message && lead.message.length > MESSAGE_LIMIT
      ? `${lead.message.slice(0, MESSAGE_LIMIT)}…`
      : lead.message;

  const details: Array<[string, string]> = [];
  if (lead.name) details.push(["Name", lead.name]);
  if (lead.email) details.push(["Email", lead.email]);
  if (lead.phone) details.push(["Phone", lead.phone]);

  const subject = who
    ? `New enquiry from ${who}`
    : `New enquiry from your website`;

  const text = [
    input.contactName ? `Hi ${input.contactName},` : "Hi there,",
    "",
    `Someone just got in touch through the ${input.businessName} website.`,
    "",
    ...details.map(([label, value]) => `${label}: ${value}`),
    ...(message ? ["", message] : []),
    "",
    lead.email ? "Reply to this email to answer them directly." : "",
    `See it in your portal: ${link}`,
  ]
    .filter((line, i, all) => !(line === "" && all[i - 1] === ""))
    .join("\n");

  const rows = details
    .map(
      ([label, value]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#6b727e;vertical-align:top">${label}</td><td style="padding:4px 0">${escapeHtml(value)}</td></tr>`,
    )
    .join("");

  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0b0d10">
<div style="max-width:520px;margin:0 auto;padding:32px 20px">
<p style="font-size:13px;color:#6b727e;margin:0 0 20px">Mortensen Web Co.</p>
<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(subject)}</h1>
<p>Someone just got in touch through the ${escapeHtml(input.businessName)} website.</p>
${rows ? `<table style="border-collapse:collapse;margin:16px 0">${rows}</table>` : ""}
${message ? `<div style="background:#fff;border:1px solid #e3e6ea;border-radius:8px;padding:12px 16px;white-space:pre-wrap">${escapeHtml(message)}</div>` : ""}
${lead.email ? `<p style="margin-top:20px"><strong>Reply to this email</strong> to answer them directly.</p>` : ""}
<p style="margin:24px 0"><a href="${link}" style="display:inline-block;background:#1552d6;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">Open in your portal</a></p>
</div></body></html>`;

  return { to: "", subject, text, html, ...(lead.email ? { replyTo: lead.email } : {}) };
}
