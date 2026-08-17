import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { AppShell } from "@/components/app-shell";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import {
  listAllChangeRequests,
  listClients,
  listProspects,
} from "@/db/repositories/admin/clients";
import { listOverduePaymentRequests } from "@/db/repositories/admin/billing";
import { isOpen, statusLabel, statusPill } from "@/lib/requests/status";
import { formatCurrency } from "@/lib/payments/venmo";

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

  const [clients, prospects, requests, moneyQueue] = await Promise.all([
    listClients(ctx, db),
    listProspects(ctx, db),
    listAllChangeRequests(ctx, db, { limit: 100 }),
    listOverduePaymentRequests(ctx, db),
  ]);

  const openRequests = requests.filter((r) => isOpen(r.status));
  const awaiting = moneyQueue.filter((r) => r.awaitingConfirmation);
  const overdue = moneyQueue.filter((r) => !r.awaitingConfirmation);
  const owed = overdue.reduce((sum, r) => sum + r.amountCents, 0);

  const needsAttention = awaiting.length + overdue.length + openRequests.length;

  // Prospects still in play. Converted and declined ones are history, and
  // counting them would make the pipeline look permanently busy.
  const liveProspects = prospects.filter(
    (p) => p.status !== "converted" && p.status !== "declined",
  ).length;

  return (
    <AppShell user={user}>
      <main className="shell">
        <div className="masthead">
          <h1>Overview</h1>
          <span className="muted">
            {clients.length} client{clients.length === 1 ? "" : "s"}
            {/* The prospect count was already being queried here and thrown
                away. Showing it is what the query was clearly fetched for, and
                it is the number that answers "is there anything in the top of
                the funnel" without a second page load. */}
            {liveProspects > 0 && (
              <>
                {" · "}
                <Link href="/admin/prospects">
                  {liveProspects} in the pipeline
                </Link>
              </>
            )}
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
            <div className="table-wrap">
              <table className="stack">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Contact</th>
                    <th>Industry</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.slice(0, 8).map((c) => (
                    <tr key={c.clientPublicId}>
                      <td data-label="Client">
                        <Link href={`/admin/clients/${c.clientPublicId}`}>
                          {c.name}
                        </Link>
                        {c.isDemo && (
                          <>
                            {" "}
                            <span className="badge">demo</span>
                          </>
                        )}
                      </td>
                      <td data-label="Contact">
                        {c.primaryContactName ?? "—"}
                      </td>
                      <td data-label="Industry">{c.industry ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Recent requests</h2>
            <Link href="/admin/requests">All requests</Link>
          </div>

          {requests.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              No change requests yet.
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
                  {requests.slice(0, 5).map((r) => (
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
            <h2>Not built yet</h2>
          </div>
          <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.9rem" }}>
            <li>
              <strong>Prospect site audits.</strong> Concept building works;
              crawling a prospect&rsquo;s existing site to extract facts does
              not. Briefs are typed by hand until it does.
            </li>
            <li>
              <strong>Square payments.</strong> Checkout links and signature
              verification are built and tested; the webhook route that receives
              them is not, so Square payments still need confirming by hand.
            </li>
            <li>
              <strong>Theme library.</strong> Stage 4. A scaffolded site is
              whatever the template repository contains.
            </li>
          </ul>
          <p className="muted" style={{ fontSize: "0.85rem", margin: "0.75rem 0 0" }}>
            Migration is gated: no client repository is read without written
            authorization naming one exact repository.
          </p>
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
