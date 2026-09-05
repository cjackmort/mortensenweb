import type { EmailMessage } from "./mailer";

/**
 * The emails a client receives while a change is in flight.
 *
 * Until these existed the portal was silent between "request sent" and the
 * client happening to open it again. A preview would be built, verified and
 * waiting within the half hour the product promises — and sit there for days,
 * because the only way to learn it existed was to go and look. These four
 * messages are the loop closing itself.
 *
 * Each one is written for a phone screen, leads with the one fact, and has a
 * single link. None of them use pipeline vocabulary: no "pull request", no
 * "deploy", no "merged". The subject lines carry the request title so a client
 * with three changes in a month can tell them apart from the inbox list.
 */

export interface RequestUpdateInput {
  contactName: string | null;
  businessName: string;
  requestTitle: string;
  portalUrl: string;
}

function greeting(name: string | null): string {
  return name ? `Hi ${name},` : "Hi there,";
}

function layout(title: string, bodyHtml: string, cta?: { href: string; label: string }): string {
  const button = cta
    ? `<p style="margin:24px 0"><a href="${cta.href}" style="display:inline-block;background:#1552d6;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">${cta.label}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0b0d10">
<div style="max-width:520px;margin:0 auto;padding:32px 20px">
<p style="font-size:13px;color:#6b727e;margin:0 0 20px">Mortensen Web Co.</p>
<h1 style="font-size:20px;margin:0 0 16px">${title}</h1>
${bodyHtml}
${button}
<p style="font-size:13px;color:#6b727e;margin-top:32px">Reply to this email if anything here doesn't look right.</p>
</div></body></html>`;
}

function requestsLink(portalUrl: string): string {
  return `${portalUrl.replace(/\/$/, "")}/dashboard/requests#awaiting-approval`;
}

/** A preview is built, verified, and waiting on the client's decision. */
export function buildPreviewReadyEmail(
  input: RequestUpdateInput & { previewUrl: string },
): EmailMessage {
  const approve = requestsLink(input.portalUrl);
  const text = `${greeting(input.contactName)}

Your change is ready to look at:

  ${input.requestTitle}

See it here (this is a preview — nothing on your live site has changed yet):
${input.previewUrl}

If it looks right, put it live from your portal:
${approve}

If something's off, the same page has "Ask for changes". That doesn't use
up another of your monthly changes — it's part of this one.`;

  const html = layout(
    "Your change is ready to look at",
    `<p><strong>${escapeHtml(input.requestTitle)}</strong></p>
<p>We've made this change on a preview of your site. Nothing on your live site has changed yet.</p>
<p><a href="${input.previewUrl}">Open the preview</a></p>
<p>If it looks right, put it live from your portal. If something's off, "Ask for changes" on the same page — that doesn't use another of your monthly changes.</p>`,
    { href: approve, label: "Review and put it live" },
  );

  return {
    to: "",
    subject: `Ready to look at: ${input.requestTitle}`,
    text,
    html,
  };
}

/** The change is on the live site and the site has been checked. */
export function buildChangeLiveEmail(
  input: RequestUpdateInput & { siteUrl: string | null },
): EmailMessage {
  const where = input.siteUrl ?? `${input.portalUrl.replace(/\/$/, "")}/dashboard`;
  const text = `${greeting(input.contactName)}

It's live:

  ${input.requestTitle}

We've checked your website and the change is there.
${input.siteUrl ?? ""}

Anything else you'd like changed, send it over in the portal.`;

  const html = layout(
    "It's live",
    `<p><strong>${escapeHtml(input.requestTitle)}</strong></p>
<p>We've checked your website and the change is there.</p>`,
    { href: where, label: input.siteUrl ? "See your site" : "Open the portal" },
  );

  return { to: "", subject: `Live: ${input.requestTitle}`, text, html };
}

/** The agent stopped and a person has picked it up. */
export function buildPersonHandlingEmail(input: RequestUpdateInput): EmailMessage {
  const text = `${greeting(input.contactName)}

A quick note on this one:

  ${input.requestTitle}

It needs a person to finish it, so Jack is picking it up himself. You don't
need to do anything — you'll get the usual "ready to look at" email once
it's done.`;

  const html = layout(
    "A person is on this one",
    `<p><strong>${escapeHtml(input.requestTitle)}</strong></p>
<p>This change needs a person to finish it, so Jack is picking it up himself. You don't need to do anything — you'll get the usual "ready to look at" email once it's done.</p>`,
  );

  return { to: "", subject: `Being handled personally: ${input.requestTitle}`, text, html };
}

/** The automated attempt failed outright; the operator has been told. */
export function buildSnagEmail(input: RequestUpdateInput): EmailMessage {
  const text = `${greeting(input.contactName)}

This one hit a snag on our side:

  ${input.requestTitle}

It's been flagged to Jack and he'll follow up with you directly. Nothing on
your website has changed, and this doesn't count against your monthly
changes.`;

  const html = layout(
    "This one hit a snag on our side",
    `<p><strong>${escapeHtml(input.requestTitle)}</strong></p>
<p>It's been flagged to Jack and he'll follow up with you directly. Nothing on your website has changed, and this doesn't count against your monthly changes.</p>`,
  );

  return { to: "", subject: `We hit a snag: ${input.requestTitle}`, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
