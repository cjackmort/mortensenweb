import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { AppShell } from "@/components/app-shell";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import {
  listAllChangeRequests,
  listClientsWithPrimarySite,
} from "@/db/repositories/admin/clients";
import { listOverduePaymentRequests } from "@/db/repositories/admin/billing";
import { isOpen, statusLabel, statusPill } from "@/lib/requests/status";
import { formatCurrency } from "@/lib/payments/venmo";

const SITE_STATUS_PILL: Record<string, string> = {
  draft: "pill-neutral",
  preview: "pill-warning",
  live: "pill-success",
  archived: "pill-neutral",
};

const SITE_STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  preview: "Demo",
  live: "Live",
  archived: "Archived",
};

export const dynamic = "force-dynamic";

/**
 * The operator's landing page.
 *
 * Answers "what needs me today" rather than listing everything that exists —
 * the detail lives behind the tabs. The two numbers that matter most are money
 * waiting on a confirmation and requests nobody has picked up, because both are
 * things a client is currently waiting on us for.
 *
 * Gated twice like every admin surface: the page check below, and
 * `adminContextFrom`, which refuses a session that is not an active admin.
 */
export default async function AdminOverview() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role !== "admin") redirect("/dashboard");

  const ctx = adminContextFrom(user);
  const db = await getDb();

  const [clients, requests, moneyQueue] = await Promise.all([
    listClientsWithPrimarySite(ctx, db),
    listAllChangeRequests(ctx, db, { limit: 100 }),
    listOverduePaymentRequests(ctx, db),
  ]);

  const openRequests = requests.filter((r) => isOpen(r.status));
  const awaiting = moneyQueue.filter((r) => r.awaitingConfirmation);
  const overdue = moneyQueue.filter((r) => !r.awaitingConfirmation);
  const owed = overdue.reduce((sum, r) => sum + r.amountCents, 0);

  const needsAttention = awaiting.length + overdue.length + openRequests.length;

  return (
    <AppShell user={user}>
      <main className="shell">
        <div className="masthead">
          <h1>Overview</h1>
          <span className="muted">
            {clients.length} client{clients.length === 1 ? "" : "s"}
          </span>
        </div>

        {needsAttention === 0 ? (
          <p className="notice notice-success">
            <strong>Nothing needs you right now.</strong> No open requests, no
            overdue invoices, nobody waiting on a confirmation.
          </p>
        ) : (
          <div className="grid grid-3">
            <Tile
              label="Waiting on you"
              value={String(awaiting.length)}
              note="clients say they paid"
              href="/admin/payments"
              tone={awaiting.length > 0 ? "pill-warning" : undefined}
            />
            <Tile
              label="Overdue"
              value={formatCurrency(owed)}
              note={`${overdue.length} invoice${overdue.length === 1 ? "" : "s"}`}
              href="/admin/payments"
              tone={overdue.length > 0 ? "pill-danger" : undefined}
            />
            <Tile
              label="Open requests"
              value={String(openRequests.length)}
              note="from clients"
              href="/admin/requests"
            />
          </div>
        )}

        <section className="card">
          <div className="card-head">
            <h2>Pending requests</h2>
            <Link href="/admin/requests">All requests</Link>
          </div>

          {openRequests.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              Nothing waiting on you. Every change request is settled.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="stack">
                <thead>
                  <tr>
                    <th>Request</th>
                    <th>Client</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {openRequests.slice(0, 8).map((r) => (
                    <tr key={r.publicId}>
                      <td data-label="Request">{r.title}</td>
                      <td data-label="Client">{r.organizationName}</td>
                      <td data-label="Status">
                        <span className={`pill ${statusPill(r.status)}`}>
                          {statusLabel(r.status)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Clients</h2>
            <Link href="/admin/clients">All clients</Link>
          </div>

          {clients.length === 0 ? (
            <div className="empty">
              <p className="empty-title">No clients yet.</p>
              <p style={{ marginTop: "1rem" }}>
                <Link className="button" href="/admin/clients/new">
                  Add your first client
                </Link>
              </p>
            </div>
          ) : (
            <div className="site-grid">
              {clients.map((c) => (
                <Link
                  key={c.clientPublicId}
                  href={`/admin/clients/${c.clientPublicId}`}
                  className="site-card"
                >
                  <div className="site-card-media">
                    <span className="site-card-initial">
                      {(c.site?.name ?? c.name).charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div className="site-card-body">
                    <div className="site-card-eyebrow">
                      <span>{c.industry ?? "Client"}</span>
                      <span
                        className={`pill ${c.site ? SITE_STATUS_PILL[c.site.status] : "pill-neutral"}`}
                      >
                        {c.site
                          ? SITE_STATUS_LABEL[c.site.status]
                          : "No site"}
                      </span>
                    </div>
                    <p className="site-card-title">
                      {c.site?.name ?? c.name}
                    </p>
                    <p className="site-card-meta">
                      {c.name}
                      {c.isDemo && (
                        <>
                          {" "}
                          <span className="badge">demo</span>
                        </>
                      )}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      </main>
    </AppShell>
  );
}

function Tile({
  label,
  value,
  note,
  href,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  href: string;
  tone?: string;
}) {
  return (
    <Link href={href} className="stat" style={{ textDecoration: "none" }}>
      <p className="stat-label">{label}</p>
      <p className="stat-value" style={{ color: "var(--text)" }}>
        {value}
      </p>
      <p className="stat-note">
        {tone ? <span className={`pill ${tone}`}>{note}</span> : note}
      </p>
    </Link>
  );
}
