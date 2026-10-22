import type { CampaignStats } from "@/db/repositories/winback-stats";
import { buildWinbackEmail, type CampaignText } from "@/lib/winback/email";
import { formatDateWithYear } from "@/lib/time";

/**
 * Pieces shared by the win-back pages: the status pill, the email as a
 * customer will see it, and the results.
 */

const STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: "Draft", tone: "pill-neutral" },
  approved: { label: "Scheduled", tone: "pill-info" },
  sending: { label: "Sending", tone: "pill-accent" },
  sent: { label: "Sent", tone: "pill-success" },
  cancelled: { label: "Cancelled", tone: "pill-neutral" },
  halted: { label: "Stopped", tone: "pill-danger" },
};

export function CampaignStatusPill({ status, scheduledFor }: { status: string; scheduledFor?: Date | null }) {
  const known = STATUS[status] ?? { label: status, tone: "pill-neutral" };
  const label = status === "approved" && !scheduledFor ? "Starting" : known.label;
  return <span className={`pill ${known.tone}`}>{label}</span>;
}

/** "Sent to 42 · 31 opened · 6 clicked", or what is happening instead. */
export function resultsLine(status: string, stats: CampaignStats, scheduledFor: Date | null): string {
  if (status === "draft") return "Not approved yet";
  if (status === "approved") return scheduledFor ? `Goes out ${formatDateWithYear(scheduledFor)}` : "Starting in the next few minutes";
  if (stats.sent === 0 && stats.notSent > 0) return "Not emailed: sending isn't set up on this portal";
  const parts = [`Sent to ${stats.sent}`];
  if (stats.sent > 0) parts.push(`${stats.opened} opened`, `${stats.clicked} clicked`);
  if (stats.waiting > 0) parts.push(`${stats.waiting} still to go`);
  return parts.join(" · ");
}

function percent(part: number, whole: number): string | undefined {
  return whole > 0 ? `${Math.round((part / whole) * 100)}% of delivered` : undefined;
}

export function CampaignResults({ stats, replyTo }: { stats: CampaignStats; replyTo: string | null }) {
  const tiles = [
    { label: "Sent", value: stats.sent, note: stats.waiting > 0 ? `${stats.waiting} still to go` : undefined },
    { label: "Delivered", value: stats.delivered },
    { label: "Opened", value: stats.opened, note: percent(stats.opened, stats.delivered) },
    { label: "Clicked", value: stats.clicked, note: percent(stats.clicked, stats.delivered) },
    { label: "Unsubscribed", value: stats.unsubscribed },
  ];
  const skipped = [
    stats.suppressed > 0 ? `${stats.suppressed} skipped because they'd unsubscribed or bounced before` : null,
    stats.bounced > 0 ? `${stats.bounced} bounced (address no longer works)` : null,
    stats.complained > 0 ? `${stats.complained} marked it as spam` : null,
    stats.failed > 0 ? `${stats.failed} couldn't be sent` : null,
    stats.halted > 0 ? `${stats.halted} not sent because it was stopped` : null,
    stats.notSent > 0 ? `${stats.notSent} not emailed: sending isn't set up on this portal` : null,
  ].filter(Boolean);

  return (
    <>
      <div className="metrics winback-metrics">
        {tiles.map((t) => (
          <div className="metric" key={t.label}>
            <p className="metric-label">{t.label}</p>
            <p className="metric-value">{t.value}</p>
            {t.note && <p className="metric-note">{t.note}</p>}
          </div>
        ))}
      </div>
      <div className="panel-body">
        {skipped.length > 0 && (
          <ul className="muted" style={{ marginTop: 0 }}>
            {skipped.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        <p className="panel-note">
          Opens are counted when someone&rsquo;s email app loads images, and many don&rsquo;t, so the real number is
          higher.{replyTo ? ` Replies go straight to ${replyTo}.` : ""}
        </p>
      </div>
    </>
  );
}

export interface PreviewInput {
  campaign: CampaignText;
  sample: { email: string; name: string | null };
  senderAddress: string;
}

/** The email for one customer, rendered as text the page can show. Links are inert here. */
export function EmailPreview({ campaign, sample, senderAddress }: PreviewInput) {
  const message = buildWinbackEmail({
    campaign,
    recipient: { publicId: "PREVIEW00000000000000000000".slice(0, 26), email: sample.email, name: sample.name },
    organizationId: "preview",
    senderAddress,
    unsubscribeUrl: "#unsubscribe",
    oneClickUrl: "#unsubscribe",
  });
  const [body, footer] = splitFooter(message.text);
  const offerAt = body.lastIndexOf("\nOffer: ");
  const main = offerAt >= 0 ? body.slice(0, offerAt).trimEnd() : body;
  const offer = offerAt >= 0 ? body.slice(offerAt + "\nOffer: ".length).trim() : null;

  return (
    <div className="winback-email" aria-label="Email preview">
      <dl className="winback-email-head">
        <dt>From</dt>
        <dd>{message.from}</dd>
        <dt>Reply to</dt>
        <dd>{message.replyTo || "—"}</dd>
        <dt>To</dt>
        <dd>{sample.name ? `${sample.name} <${sample.email}>` : sample.email}</dd>
        <dt>Subject</dt>
        <dd>
          <strong>{message.subject || "—"}</strong>
        </dd>
      </dl>
      <div className="winback-email-body">
        {main}
        {offer && (
          <p className="winback-email-offer">
            <strong>Offer:</strong> {offer}
          </p>
        )}
        <p className="winback-email-foot">
          {footer.map((line, i) => (
            <span key={i}>
              {line.startsWith("Unsubscribe:") ? <u>Unsubscribe</u> : line}
              <br />
            </span>
          ))}
        </p>
      </div>
    </div>
  );
}

function splitFooter(text: string): [string, string[]] {
  const at = text.lastIndexOf("\n--\n");
  if (at < 0) return [text, []];
  return [text.slice(0, at).trimEnd(), text.slice(at + 4).split("\n")];
}
