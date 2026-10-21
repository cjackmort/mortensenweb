import type { EmailMessage } from "./mailer";

/**
 * The email that sends a prospect their demo site and asks for a call.
 *
 * The operator edits it before it goes, so this is a starting draft: short,
 * the link on a line of its own so it is tappable on a phone, and one clear
 * ask. Sent as written; the HTML copy only turns the text into paragraphs
 * and makes the demo link clickable.
 */

export interface DemoInviteDraftInput {
  businessName: string;
  contactName: string | null;
  demoUrl: string;
  /** The operator's own name, when their account has one. */
  senderName: string | null;
}

export function demoInviteDraft(input: DemoInviteDraftInput): { subject: string; body: string } {
  const greeting = input.contactName ? `Hi ${input.contactName},` : "Hi there,";
  const signOff = input.senderName ? `${input.senderName}\nMortensen Web Co.` : "Mortensen Web Co.";
  return {
    subject: `A new website for ${input.businessName}`,
    body: `${greeting}

I built a demo of a new website for ${input.businessName}:

${input.demoUrl}

Have a look on your phone. If you like where it's going, could we get on a quick call this week? I'll walk you through it, and you can tell me what you'd change.

What day and time work for you?

Thanks,
${signOff}`,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The operator's text as an email: paragraphs, with the demo link clickable. */
export function buildDemoInviteEmail(input: { subject: string; body: string; demoUrl: string }): EmailMessage {
  const link = escapeHtml(input.demoUrl);
  const paragraphs = input.body
    .split(/\n{2,}/)
    .map((block) => escapeHtml(block.trim()).replace(/\n/g, "<br>"))
    .filter(Boolean)
    .map((block) => block.split(link).join(`<a href="${link}" style="color:#1c1917">${link}</a>`))
    .map((block) => `<p style="margin:0 0 16px">${block}</p>`)
    .join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c1917;line-height:1.6">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
${paragraphs}
</div></body></html>`;

  return { to: "", subject: input.subject, text: input.body, html };
}
