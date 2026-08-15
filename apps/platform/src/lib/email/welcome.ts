import type { EmailMessage } from "./mailer";

/**
 * The welcome email.
 *
 * This is the single highest-stakes piece of copy in the product: it is the
 * only instruction most clients will ever read, and it arrives on a phone. It
 * therefore leads with the two credentials, states the expiry plainly, and puts
 * the home-screen instructions *after* sign-in rather than before — a client
 * asked to install something before they have seen any value usually does
 * neither.
 *
 * iOS and Android are given separately because the gesture genuinely differs,
 * and "add to home screen" on iOS is only available in Safari. Telling an
 * iPhone user to do it in Chrome produces a support call.
 */

export interface WelcomeEmailInput {
  businessName: string;
  contactName: string | null;
  username: string;
  temporaryPassword: string;
  portalUrl: string;
  expiresAt: Date;
}

function formatExpiry(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: process.env.BUSINESS_TIMEZONE ?? "America/Denver",
  });
}

export function buildWelcomeEmail(input: WelcomeEmailInput): EmailMessage {
  const greeting = input.contactName ? `Hi ${input.contactName},` : "Hi there,";
  const getStartedUrl = `${input.portalUrl.replace(/\/$/, "")}/get-started`;
  const expiry = formatExpiry(input.expiresAt);

  const text = `${greeting}

Your website portal for ${input.businessName} is ready. This is where you'll
request changes, see your traffic, and check your billing.

Sign in here: ${getStartedUrl}

  Username:            ${input.username}
  Temporary password:  ${input.temporaryPassword}

Tap "Get started", enter those two, and you'll be asked to pick your own
password. The temporary one above stops working at that point, and expires on
${expiry} if unused.

──────────────────────────────────────────────

KEEP IT ON YOUR PHONE

Once you're signed in, save the portal to your home screen so it opens like an
app — no app store, no download.

iPhone / iPad (must be Safari):
  1. Open ${input.portalUrl} in Safari
  2. Tap the Share button (the square with an arrow pointing up)
  3. Scroll down and tap "Add to Home Screen"
  4. Tap "Add"

Android (Chrome):
  1. Open ${input.portalUrl} in Chrome
  2. Tap the three dots in the top right
  3. Tap "Add to Home screen", then "Install"

──────────────────────────────────────────────

Trouble signing in? Just reply to this email and we'll sort it out.

— Mortensen Web Co.`;

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c1917;line-height:1.6">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">

<p style="margin:0 0 16px">${greeting}</p>

<p style="margin:0 0 24px">Your website portal for <strong>${escapeHtml(input.businessName)}</strong> is ready. This is where you&rsquo;ll request changes, see your traffic, and check your billing.</p>

<div style="text-align:center;margin:0 0 24px">
  <a href="${getStartedUrl}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600">Get started</a>
</div>

<table style="width:100%;border-collapse:collapse;background:#fafaf9;border-radius:8px;margin:0 0 8px">
  <tr><td style="padding:16px 16px 4px;font-size:13px;color:#78716c">Username</td></tr>
  <tr><td style="padding:0 16px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:16px;font-weight:600">${escapeHtml(input.username)}</td></tr>
  <tr><td style="padding:0 16px 4px;font-size:13px;color:#78716c">Temporary password</td></tr>
  <tr><td style="padding:0 16px 16px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:16px;font-weight:600">${escapeHtml(input.temporaryPassword)}</td></tr>
</table>

<p style="margin:0 0 24px;font-size:14px;color:#57534e">You&rsquo;ll be asked to pick your own password straight away. The temporary one stops working at that point, and expires on ${escapeHtml(expiry)} if unused.</p>

<hr style="border:none;border-top:1px solid #e7e5e4;margin:0 0 24px">

<p style="margin:0 0 8px;font-weight:600">Keep it on your phone</p>
<p style="margin:0 0 16px;font-size:14px;color:#57534e">Once you&rsquo;re signed in, save the portal to your home screen so it opens like an app &mdash; no app store, no download.</p>

<p style="margin:0 0 4px;font-size:14px;font-weight:600">iPhone or iPad &mdash; must be Safari</p>
<ol style="margin:0 0 16px;padding-left:20px;font-size:14px;color:#57534e">
  <li>Open the portal in Safari</li>
  <li>Tap the Share button &mdash; the square with an arrow pointing up</li>
  <li>Scroll down and tap &ldquo;Add to Home Screen&rdquo;</li>
  <li>Tap &ldquo;Add&rdquo;</li>
</ol>

<p style="margin:0 0 4px;font-size:14px;font-weight:600">Android &mdash; Chrome</p>
<ol style="margin:0 0 24px;padding-left:20px;font-size:14px;color:#57534e">
  <li>Open the portal in Chrome</li>
  <li>Tap the three dots in the top right</li>
  <li>Tap &ldquo;Add to Home screen&rdquo;, then &ldquo;Install&rdquo;</li>
</ol>

<hr style="border:none;border-top:1px solid #e7e5e4;margin:0 0 24px">

<p style="margin:0;font-size:14px;color:#57534e">Trouble signing in? Just reply to this email and we&rsquo;ll sort it out.</p>
<p style="margin:16px 0 0;font-size:14px">&mdash; Mortensen Web Co.</p>

</div></body></html>`;

  return {
    to: "",
    subject: `Your ${input.businessName} website portal is ready`,
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
