import type { EmailMessage } from "./mailer";

/**
 * To the operator: a client says they've bought their domain and given us
 * access. Their word, not a check — the email says what to look for in the
 * registrar's invitations, and links to the client page with the DNS records.
 */
export function buildDomainAccessEmail(input: {
  businessName: string;
  domain: string;
  registrar: string;
  clientUrl: string;
}): EmailMessage {
  const text = `${input.businessName} says they've given us access to ${input.domain} at ${input.registrar}.

Look for the invitation from ${input.registrar} and accept it, then add the Netlify DNS records. They're on the client page:

${input.clientUrl}

— Mortensen Web Co. portal`;

  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c1917;line-height:1.6">
<p><strong>${escape(input.businessName)}</strong> says they've given us access to <strong>${escape(input.domain)}</strong> at ${escape(input.registrar)}.</p>
<p>Look for the invitation from ${escape(input.registrar)} and accept it, then add the Netlify DNS records. They're on the <a href="${escape(input.clientUrl)}">client page</a>.</p>
</body></html>`;

  return { to: "", subject: `Domain access: ${input.domain} (${input.registrar}) for ${input.businessName}`, text, html };
}
