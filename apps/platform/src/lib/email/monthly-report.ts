import type { MonthlyReportData } from "@/lib/reports/types";
import { glance, headline } from "@/lib/reports/wording";
import type { EmailMessage } from "./mailer";

/**
 * The monthly report email: the headline, one line per section, and a link.
 *
 * A subscription a client never sees working is one they cancel, so this is
 * the month's work made visible in thirty seconds on a phone. The detail lives
 * in the portal; the email is the summary and the way in. Missing figures are
 * stated as missing here exactly as on the page, from the same wording module.
 *
 * Opting out happens in the portal, behind the client's own sign-in, rather
 * than through a one-click link: one fewer public endpoint, and the only
 * people receiving this are the client's own portal users.
 */

export interface MonthlyReportEmailInput {
  contactName: string | null;
  data: MonthlyReportData;
  portalUrl: string;
}

function base(portalUrl: string): string {
  return portalUrl.replace(/\/$/, "");
}

export function reportUrl(portalUrl: string, period: string): string {
  return `${base(portalUrl)}/dashboard/reports/${period}`;
}

export function reportSettingsUrl(portalUrl: string): string {
  return `${base(portalUrl)}/dashboard/reports#emails`;
}

export function buildMonthlyReportEmail(input: MonthlyReportEmailInput): EmailMessage {
  const { data } = input;
  const summary = headline(data);
  const lines = glance(data);
  const link = reportUrl(input.portalUrl, data.period);
  const settings = reportSettingsUrl(input.portalUrl);
  const hello = input.contactName ? `Hi ${input.contactName},` : "Hi there,";
  const site = data.site?.domain ?? data.site?.name ?? null;

  const text = `${hello}

Here's how ${site ?? "your website"} did in ${data.label}.

${lines.map((line) => `  ${line.title}: ${line.text}`).join("\n")}

The full report, with your top pages and where visitors came from:
${link}

Anything you'd like changed, just reply.

You get this once a month. To stop it, use the switch at the bottom of your
reports page: ${settings}`;

  const rows = lines
    .map(
      (line) =>
        `<tr><td style="padding:8px 12px 8px 0;color:#6b727e;vertical-align:top;white-space:nowrap">${escapeHtml(line.title)}</td><td style="padding:8px 0;vertical-align:top;${line.missing ? "color:#6b727e;font-style:italic" : "font-weight:600"}">${escapeHtml(line.text)}</td></tr>`,
    )
    .join("");

  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0b0d10">
<div style="max-width:520px;margin:0 auto;padding:32px 20px">
<p style="font-size:13px;color:#6b727e;margin:0 0 20px">Mortensen Web Co. · ${escapeHtml(data.label)} report</p>
<p style="margin:0 0 8px">${escapeHtml(hello)}</p>
<p style="margin:0 0 20px">Here's how ${escapeHtml(site ?? "your website")} did in ${escapeHtml(data.label)}.</p>
<h1 style="font-size:20px;line-height:1.35;margin:0 0 16px">${escapeHtml(summary)}</h1>
<table role="presentation" style="border-collapse:collapse;font-size:15px;margin:0 0 8px">${rows}</table>
<p style="margin:24px 0"><a href="${link}" style="display:inline-block;background:#1552d6;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">See the full report</a></p>
<p style="margin:0">Anything you'd like changed, just reply.</p>
<p style="font-size:13px;color:#6b727e;margin-top:32px">You get this once a month. To stop it, use the switch at the bottom of <a href="${settings}" style="color:#6b727e">your reports page</a>.</p>
</div></body></html>`;

  return {
    to: "",
    subject: `Your ${data.label} report: ${summary}`,
    text,
    html,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
