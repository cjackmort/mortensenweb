import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { listConnectedAccounts, type ConnectedAccountView } from "@/db/repositories/client/connections";
import { CONNECTION_PROVIDERS, PROVIDERS, type ConnectionProvider } from "@/lib/connections";
import { STRIPE_KEY_PERMISSIONS } from "@/lib/connections/providers/stripe";
import type { Finding } from "@/lib/connections/types";
import { formatDateTime } from "@/lib/time";
import { ConnectedControls } from "./forms";
import { StripeKeyForm } from "./stripe-key-form";

/**
 * Connections: the accounts a client lets the portal look at — Stripe,
 * Google Search Console, Instagram — and what the last look found.
 *
 * One card per provider whether connected or not, so the client sees what
 * each would tell them before deciding. A card says, before the button,
 * exactly what is read and what never is: the question anyone sensible asks
 * before pressing "Connect" on a Stripe account.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Connections",
  robots: { index: false, follow: false },
};

const OUTCOMES: Record<string, { tone: "success" | "info" | "warning"; text: string }> = {
  connected: { tone: "success", text: "Connected, and looked at just now — the findings are below." },
  connected_unread: {
    tone: "info",
    text: "Connected. It couldn't be looked at just now; press “Look again now” in a minute, or we will overnight.",
  },
  denied: { tone: "info", text: "Nothing was connected — you stopped at the sign-in." },
  expired: { tone: "warning", text: "That sign-in took too long or was opened in another browser. Try again." },
  failed: { tone: "warning", text: "The connection couldn't be completed. Try again, and let us know if it keeps happening." },
  not_configured: { tone: "info", text: "That account can't be connected yet. We will switch it on and let you know." },
  not_allowed: { tone: "info", text: "Connections are made by the client themselves, not while viewing as them." },
  disconnected: { tone: "success", text: "Disconnected. Nothing from it will be in your next report." },
};

const SEVERITY: Record<Finding["severity"], { label: string; pill: string }> = {
  fix: { label: "Fix", pill: "pill-danger" },
  improve: { label: "Improve", pill: "pill-warning" },
  good: { label: "Good", pill: "pill-success" },
};

function parseOutcome(raw: string | undefined): { provider: ConnectionProvider; outcome: string } | null {
  const [provider, outcome] = (raw ?? "").split(":");
  if (!provider || !outcome || !(CONNECTION_PROVIDERS as readonly string[]).includes(provider)) return null;
  return { provider: provider as ConnectionProvider, outcome };
}

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ connect?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.organizationId) {
    return (
      <main className="shell">
        <p className="notice">Your account is not linked to an organization yet. Please contact us.</p>
      </main>
    );
  }

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  const accounts = await listConnectedAccounts(db, ctx);
  const byProvider = new Map(accounts.map((a) => [a.provider, a]));
  const readOnly = ctx.impersonating;
  const { connect } = await searchParams;
  const outcome = parseOutcome(connect);
  const notice = outcome ? OUTCOMES[outcome.outcome] : null;
  // A key the client made is theirs to delete; say so where they will see it.
  const adapter = outcome ? PROVIDERS[outcome.provider] : null;
  const afterward =
    outcome?.outcome === "disconnected" && adapter?.connectWith === "key" ? ` ${adapter.afterDisconnect}` : "";

  return (
    <main className="shell">
      <div className="masthead">
        <h1>Connections</h1>
        <span>Accounts we look over for you</span>
      </div>

      <p className="page-intro">
        Connect an account and we look at it once a day, read-only. What we find goes here and into
        your <Link href="/dashboard/reports">monthly report</Link>: what to fix, what to improve, and what is
        working. Disconnect at any time.
      </p>

      {notice && outcome && (
        <p className={`notice notice-${notice.tone}`} role="status">
          <strong>{PROVIDERS[outcome.provider].name}:</strong> {notice.text}
          {afterward}
        </p>
      )}

      {CONNECTION_PROVIDERS.map((key) => (
        <ProviderCard key={key} provider={key} account={byProvider.get(key) ?? null} readOnly={readOnly} />
      ))}
    </main>
  );
}

function ProviderCard({
  provider,
  account,
  readOnly,
}: {
  provider: ConnectionProvider;
  account: ConnectedAccountView | null;
  readOnly: boolean;
}) {
  const adapter = PROVIDERS[provider];
  const configured = adapter.configured();
  const connected = account && account.status !== "revoked";

  return (
    <section className="panel" id={provider} aria-labelledby={`connection-${provider}`}>
      <div className="panel-head">
        <h2 id={`connection-${provider}`}>{adapter.name}</h2>
        <span className="panel-sub">
          {connected ? (
            account.status === "needs_reconnect" ? (
              <span className="pill pill-warning">Needs reconnecting</span>
            ) : (
              <span className="pill pill-success">Connected{account.displayName ? ` · ${account.displayName}` : ""}</span>
            )
          ) : configured.ok ? (
            <span className="pill pill-neutral">Not connected</span>
          ) : (
            <span className="pill pill-neutral">Coming soon</span>
          )}
        </span>
      </div>
      <div className="panel-body">
        {connected && account.status === "connected" ? (
          <ConnectedBody account={account} readOnly={readOnly} />
        ) : (
          <>
            <p style={{ marginTop: 0 }}>
              Connect {adapter.what} and we look at:
            </p>
            <ul className="connection-looks">
              {adapter.looksAt.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="field-hint">{adapter.never}</p>
            {connected && account.status === "needs_reconnect" && (
              <p className="notice notice-warning">
                The connection lapsed{account.lastError ? ` (${account.lastError})` : ""}. Connect it again to carry on.
              </p>
            )}
            {configured.ok ? (
              readOnly ? (
                <p className="muted">Viewing as the client: connections are theirs to make.</p>
              ) : adapter.connectWith === "key" ? (
                <StripeKeyForm permissions={STRIPE_KEY_PERMISSIONS} reconnect={Boolean(connected)} />
              ) : (
                <a className="button" href={`/api/connections/${provider}/start`}>
                  {connected ? `Reconnect ${adapter.name}` : `Connect ${adapter.name}`}
                </a>
              )
            ) : (
              <p className="muted">Not switched on yet. Tell us if you would like it and we will set it up.</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function ConnectedBody({ account, readOnly }: { account: ConnectedAccountView; readOnly: boolean }) {
  const audit = account.lastAudit;
  return (
    <>
      {audit ? (
        <>
          <p className="connection-headline">{audit.headline}</p>
          <dl className="detail-grid">
            {audit.rows.map((row) => (
              <div key={row.label} style={{ display: "contents" }}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
          <ul className="connection-findings">
            {audit.findings.map((finding) => (
              <li key={finding.title}>
                <span className={`pill ${SEVERITY[finding.severity].pill}`}>{SEVERITY[finding.severity].label}</span>
                <div>
                  <strong>{finding.title}</strong>
                  <p>{finding.detail}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className="field-hint">
            Looked at {account.lastAuditAt ? formatDateTime(account.lastAuditAt) : "—"}, covering the last 30 days.
            {account.lastError && ` The most recent look failed: ${account.lastError}`}
          </p>
        </>
      ) : (
        <p className="muted" style={{ marginTop: 0 }}>
          Connected {formatDateTime(account.connectedAt)}. Not looked at yet
          {account.lastError ? ` — the last try failed: ${account.lastError}` : ""}.
        </p>
      )}
      <ConnectedControls provider={account.provider} readOnly={readOnly} />
    </>
  );
}
