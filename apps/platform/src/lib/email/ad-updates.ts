import type { EmailMessage } from "./mailer";

/**
 * The emails a client gets about an ad campaign: when it needs changing,
 * when it goes live, and when money goes back to them.
 *
 * Written like the request emails: for a phone, one fact first, one link.
 * No platform vocabulary — no "ad set", no "policy violation code".
 */

export interface AdUpdateInput {
  contactName: string | null;
  campaignName: string;
  campaignUrl: string;
}

function greeting(name: string | null): string {
  return name ? `Hi ${name},` : "Hi there,";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function layout(title: string, bodyHtml: string, cta: { href: string; label: string }): string {
  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0b0d10">
<div style="max-width:520px;margin:0 auto;padding:32px 20px">
<p style="font-size:13px;color:#6b727e;margin:0 0 20px">Mortensen Web Co.</p>
<h1 style="font-size:20px;margin:0 0 16px">${title}</h1>
${bodyHtml}
<p style="margin:24px 0"><a href="${cta.href}" style="display:inline-block;background:#1552d6;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">${cta.label}</a></p>
<p style="font-size:13px;color:#6b727e;margin-top:32px">Reply to this email if anything here doesn't look right.</p>
</div></body></html>`;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** We checked the ad and it can't run as written. */
export function buildAdNeedsChangesEmail(input: AdUpdateInput & { note: string }): EmailMessage {
  const text = `${greeting(input.contactName)}

We checked your ad "${input.campaignName}" and it needs a change before it can run:

${input.note}

Change it here and send it back to us. Nothing extra is charged:
${input.campaignUrl}`;

  return {
    to: "",
    subject: `Your ad needs a change: ${input.campaignName}`,
    text,
    html: layout(
      "Your ad needs a change before it can run",
      `<p><strong>${escapeHtml(input.campaignName)}</strong></p>
<p style="padding:12px 16px;background:#fdf0ee;border-left:3px solid #b42318">${escapeHtml(input.note)}</p>
<p>Change it and send it back to us. Nothing extra is charged.</p>`,
      { href: input.campaignUrl, label: "Change your ad" },
    ),
  };
}

/** It's running. */
export function buildAdLiveEmail(input: AdUpdateInput & { dates: string | null }): EmailMessage {
  const when = input.dates ? ` It runs ${input.dates}.` : "";
  const text = `${greeting(input.contactName)}

Your ad "${input.campaignName}" is live.${when}

You can watch how it does, and where it was seen, in your portal. Results
update a few times a day:
${input.campaignUrl}`;

  return {
    to: "",
    subject: `Your ad is live: ${input.campaignName}`,
    text,
    html: layout(
      "Your ad is live",
      `<p><strong>${escapeHtml(input.campaignName)}</strong>${escapeHtml(when)}</p>
<p>You can watch how it does, and where it was seen, in your portal. Results update a few times a day.</p>`,
      { href: input.campaignUrl, label: "See how it's doing" },
    ),
  };
}

/** Money went back to their card. */
export function buildAdRefundEmail(
  input: AdUpdateInput & { refundCents: number; spentCents: number; feeCents: number; ranAtAll: boolean },
): EmailMessage {
  const why = input.ranAtAll
    ? `Your ad spent ${dollars(input.spentCents)} of its budget, and the management fee on that is ${dollars(input.feeCents)}.`
    : "Your ad didn't run, so you get everything back, fee included.";
  const text = `${greeting(input.contactName)}

We've refunded ${dollars(input.refundCents)} to your card for "${input.campaignName}".

${why}

Card refunds usually take 5 to 10 days to show on a statement. The details
are in your portal:
${input.campaignUrl}`;

  return {
    to: "",
    subject: `Refund on your ad: ${dollars(input.refundCents)}`,
    text,
    html: layout(
      `We've refunded ${dollars(input.refundCents)} to your card`,
      `<p><strong>${escapeHtml(input.campaignName)}</strong></p>
<p>${escapeHtml(why)}</p>
<p>Card refunds usually take 5 to 10 days to show on a statement.</p>`,
      { href: input.campaignUrl, label: "See the details" },
    ),
  };
}
