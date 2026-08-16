import type { EmailMessage } from "./mailer";

/**
 * The password reset email.
 *
 * Written for someone who is locked out and mildly annoyed, reading on a phone.
 * It therefore leads with the button, states the one-hour expiry next to it
 * rather than in a footer, and says plainly what to do if they did not ask for
 * it — an unrequested reset email is the earliest signal a client gets that
 * someone is probing their account, and burying that line wastes it.
 *
 * The token appears only inside the link. It is never printed as a standalone
 * value, because a bare token in an inbox invites forwarding.
 */

export interface PasswordResetEmailInput {
  contactName: string | null;
  resetUrl: string;
  expiresAt: Date;
  ttlMinutes: number;
}

export function buildPasswordResetEmail(
  input: PasswordResetEmailInput,
): EmailMessage {
  const greeting = input.contactName ? `Hi ${input.contactName},` : "Hi there,";
  const window = `${input.ttlMinutes} minutes`;

  const text = `${greeting}

Someone asked to reset the password on your Mortensen Web Co. portal account.

Open this link to choose a new one:

${input.resetUrl}

The link works once and expires in ${window}. If it has already expired, just
request another from the sign-in page.

DIDN'T ASK FOR THIS?

Then ignore this email — nothing has changed and your current password still
works. If you get these repeatedly, reply and tell us; it means someone is
trying your account.

— Mortensen Web Co.`;

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c1917;line-height:1.6">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">

<p style="margin:0 0 16px">${escapeHtml(greeting)}</p>

<p style="margin:0 0 24px">Someone asked to reset the password on your Mortensen Web Co. portal account.</p>

<div style="text-align:center;margin:0 0 12px">
  <a href="${escapeAttribute(input.resetUrl)}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600">Choose a new password</a>
</div>

<p style="margin:0 0 24px;text-align:center;font-size:14px;color:#78716c">This link works once and expires in ${escapeHtml(window)}.</p>

<hr style="border:none;border-top:1px solid #e7e5e4;margin:0 0 24px">

<p style="margin:0 0 8px;font-weight:600">Didn&rsquo;t ask for this?</p>
<p style="margin:0 0 24px;font-size:14px;color:#57534e">Ignore this email &mdash; nothing has changed and your current password still works. If you get these repeatedly, reply and tell us; it means someone is trying your account.</p>

<p style="margin:0;font-size:14px">&mdash; Mortensen Web Co.</p>

</div></body></html>`;

  return {
    to: "",
    subject: "Reset your Mortensen Web Co. portal password",
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

/**
 * Attribute context is stricter than text context: a single quote or a stray
 * angle bracket in a URL must not be able to close the attribute and open a new
 * one. The URL is built from configuration and a hex token, so this is
 * belt-and-braces rather than a live hole — but the next person to edit this
 * template should not have to know that.
 */
function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
