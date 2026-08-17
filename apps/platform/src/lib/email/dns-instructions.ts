import type { EmailMessage } from "./mailer";
import { renderRecordsText, type DnsRecord } from "@/lib/dns/records";

/**
 * "Here's how to point your domain at the new site."
 *
 * The hardest email we send, because the reader is being asked to log into a
 * system they use once every few years and edit something they do not
 * understand, where a mistake takes their business offline.
 *
 * The copy is built around three decisions:
 *
 * **The offer of a call comes first, not last.** Buried at the bottom it reads
 * as a formality. At the top it gives permission to not attempt this, which for
 * a good proportion of readers is the right answer and saves everyone an hour.
 *
 * **The records are given before the explanation.** Someone who knows what they
 * are doing wants the values and nothing else, and making them scroll past four
 * paragraphs of reassurance is its own kind of rude.
 *
 * **The waiting period is stated as normal, with a number.** "It can take up to
 * 48 hours" prevents the 2am email that says the website is broken. Without it
 * that email always arrives.
 */

export interface DnsEmailInput {
  businessName: string;
  contactName: string | null;
  domain: string;
  records: DnsRecord[];
  portalUrl: string;
}

export function buildDnsInstructionsEmail(input: DnsEmailInput): EmailMessage {
  const greeting = input.contactName ? `Hi ${input.contactName},` : "Hi there,";
  const table = renderRecordsText(input.records);

  const text = `${greeting}

Your new website for ${input.businessName} is built and ready. The last step is
pointing ${input.domain} at it, which is done at whoever you bought the domain
from — GoDaddy, Namecheap, Google Domains, or similar.

If you'd rather not do this yourself, just reply and we'll get on a call and do
it together. It takes about ten minutes and there's no charge. Plenty of people
prefer that, and it's genuinely no trouble.

If you'd like to do it yourself, here's what you need.

Log in where you bought ${input.domain}, find the DNS settings (sometimes called
"DNS management", "name servers and DNS", or "advanced DNS"), and add these:

${table}

${input.records.map((record) => `${record.type} record — ${record.note}`).join("\n")}

A few things worth knowing:

  * If a record of the same type already exists for that host, change it rather
    than adding a second one.
  * Leave everything else alone. In particular, don't touch anything labelled MX
    or TXT — that's your email, and changing it will stop mail arriving.
  * Don't change your nameservers. Some guides suggest it. You don't need to,
    and it moves more than we're asking for.

Once you've saved the records, it can take anywhere from a few minutes to 48
hours for the internet to catch up. That's normal and there's nothing wrong if
your site isn't there straight away. Your current site keeps working the whole
time — nothing goes offline in between.

We'll be watching, and we'll email you the moment it's live.

Anything at all, just reply.

— Mortensen Web Co.
${input.portalUrl}
`;

  const rows = input.records
    .map(
      (record) => `      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e3ded6;font-family:ui-monospace,Menlo,Consolas,monospace;">${record.type}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e3ded6;font-family:ui-monospace,Menlo,Consolas,monospace;">${record.host}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e3ded6;font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all;">${record.value}</td>
      </tr>`,
    )
    .join("\n");

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:24px;background:#fbfaf8;color:#1c1917;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;line-height:1.55;">
  <div style="max-width:34rem;margin:0 auto;background:#ffffff;border:1px solid #e3ded6;border-radius:10px;padding:24px;">
    <p>${greeting}</p>

    <p>Your new website for <strong>${input.businessName}</strong> is built and
    ready. The last step is pointing <strong>${input.domain}</strong> at it, which
    is done at whoever you bought the domain from.</p>

    <p style="background:#f7ede7;border-left:3px solid #8a4b2a;padding:12px 16px;border-radius:0 6px 6px 0;">
      <strong>Would you rather we did this together?</strong> Just reply and
      we&rsquo;ll get on a call. It takes about ten minutes and there&rsquo;s no
      charge.
    </p>

    <p>Otherwise: log in where you bought ${input.domain}, find the DNS settings
    (sometimes called &ldquo;DNS management&rdquo; or &ldquo;advanced
    DNS&rdquo;), and add these.</p>

    <table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0;">
      <thead>
        <tr>
          <th align="left" style="padding:8px 12px;border-bottom:2px solid #cfc7bb;">Type</th>
          <th align="left" style="padding:8px 12px;border-bottom:2px solid #cfc7bb;">Host</th>
          <th align="left" style="padding:8px 12px;border-bottom:2px solid #cfc7bb;">Value</th>
        </tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>

    <ul style="padding-left:1.1rem;">
      <li>If a record of the same type already exists for that host, change it
      rather than adding a second one.</li>
      <li><strong>Leave everything else alone</strong> — especially anything
      labelled MX or TXT. That&rsquo;s your email, and changing it will stop mail
      arriving.</li>
      <li><strong>Don&rsquo;t change your nameservers.</strong> Some guides
      suggest it. You don&rsquo;t need to, and it moves more than we&rsquo;re
      asking for.</li>
    </ul>

    <p>Once saved, it can take anywhere from a few minutes to 48 hours for the
    internet to catch up. That&rsquo;s normal. Your current site keeps working
    the whole time &mdash; nothing goes offline in between.</p>

    <p>We&rsquo;ll be watching, and we&rsquo;ll email you the moment it&rsquo;s
    live.</p>

    <p style="color:#6b6660;font-size:14px;margin-bottom:0;">
      &mdash; Mortensen Web Co.<br />
      <a href="${input.portalUrl}" style="color:#8a4b2a;">${input.portalUrl}</a>
    </p>
  </div>
</body>
</html>`;

  return {
    to: "",
    subject: `Pointing ${input.domain} at your new site`,
    text,
    html,
  };
}

/**
 * "Your site is live."
 *
 * Sent only after the production URL has actually been fetched and answered —
 * never on a successful deploy alone. A deploy succeeding and a domain
 * resolving are different events separated by DNS propagation and certificate
 * issue, either of which can fail. Announcing the second when only the first
 * has happened sends the client to a broken page in a celebratory email.
 */
export function buildSiteLiveEmail(input: {
  businessName: string;
  contactName: string | null;
  domain: string;
  portalUrl: string;
}): EmailMessage {
  const greeting = input.contactName ? `Hi ${input.contactName},` : "Hi there,";
  const siteUrl = `https://${input.domain}`;

  const text = `${greeting}

${input.domain} is live. We've checked it ourselves — it's up and serving.

  ${siteUrl}

From here on, anything you'd like changed goes through your portal:

  ${input.portalUrl}/dashboard/requests

Describe what you want, add photos if it helps, and we'll send you a preview to
look at before anything changes on the real site. Nothing goes live without you
approving it first.

You can also see your visitor numbers there.

Congratulations — it looks good.

— Mortensen Web Co.
`;

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:24px;background:#fbfaf8;color:#1c1917;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;line-height:1.55;">
  <div style="max-width:34rem;margin:0 auto;background:#ffffff;border:1px solid #e3ded6;border-radius:10px;padding:24px;">
    <p>${greeting}</p>
    <p><strong>${input.domain} is live.</strong> We&rsquo;ve checked it ourselves
    &mdash; it&rsquo;s up and serving.</p>
    <p style="text-align:center;margin:24px 0;">
      <a href="${siteUrl}" style="display:inline-block;background:#8a4b2a;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:650;">Visit your site</a>
    </p>
    <p>From here on, anything you&rsquo;d like changed goes through your portal.
    Describe what you want, add photos if it helps, and we&rsquo;ll send you a
    preview to look at &mdash; nothing goes live without you approving it first.</p>
    <p>You can see your visitor numbers there too.</p>
    <p style="text-align:center;margin:24px 0;">
      <a href="${input.portalUrl}/dashboard/requests" style="color:#8a4b2a;">Open your portal</a>
    </p>
    <p style="color:#6b6660;font-size:14px;margin-bottom:0;">
      Congratulations &mdash; it looks good.<br />&mdash; Mortensen Web Co.
    </p>
  </div>
</body>
</html>`;

  return { to: "", subject: `${input.domain} is live`, text, html };
}
