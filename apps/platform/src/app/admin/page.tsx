import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import {
  listAllChangeRequests,
  listClients,
  listProspects,
} from "@/db/repositories/admin/clients";

export const dynamic = "force-dynamic";

/**
 * Admin overview.
 *
 * Gated twice: middleware rejects non-admins before this renders, and
 * `adminContextFrom` throws if the session is not an active admin. The second
 * check is the load-bearing one — middleware is a convenience, not a boundary.
 */
export default async function AdminOverview() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");

  const ctx = adminContextFrom(user);
  const db = await getDb();

  const [clients, prospects, requests] = await Promise.all([
    listClients(ctx, db),
    listProspects(ctx, db),
    listAllChangeRequests(ctx, db, { limit: 10 }),
  ]);

  return (
    <main className="shell">
      <div className="masthead">
        <h1>Mortensen Web Co. — Admin</h1>
        <span className="muted">
          {user.email} · admin
        </span>
      </div>

      <p className="notice">
        <strong>Stage 3 pending.</strong> This is the Stage 2 foundation view.
        Current Clients, Potential Clients, Requests, Themes, Payments, and
        Analytics get their full interfaces in Stage 3. All data below is
        clearly-labelled demo data.
      </p>

      <section className="card">
        <h2>Current clients ({clients.length})</h2>
        <table>
          <thead>
            <tr>
              <th>Client</th>
              <th>Contact</th>
              <th>Industry</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.clientPublicId}>
                <td>{c.name}</td>
                <td>{c.primaryContactName ?? "—"}</td>
                <td>{c.industry ?? "—"}</td>
                <td>{c.isDemo && <span className="badge">demo</span>}</td>
              </tr>
            ))}
            {clients.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No clients yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Potential clients ({prospects.length})</h2>
        <table>
          <thead>
            <tr>
              <th>Business</th>
              <th>Source</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {prospects.map((p) => (
              <tr key={p.publicId}>
                <td>{p.businessName}</td>
                <td className="muted">{p.sourceWebsiteUrl ?? "—"}</td>
                <td>{p.status}</td>
                <td>{p.isDemo && <span className="badge">demo</span>}</td>
              </tr>
            ))}
            {prospects.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No prospects yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Recent requests ({requests.length})</h2>
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Client</th>
              <th>Status</th>
              <th>Priority</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((r) => (
              <tr key={r.publicId}>
                <td>{r.title}</td>
                <td className="muted">{r.organizationName}</td>
                <td>{r.status}</td>
                <td>{r.priority}</td>
              </tr>
            ))}
            {requests.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No requests yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Migration</h2>
        <p className="muted" style={{ margin: 0 }}>
          No migration is possible until you provide written authorization
          naming one exact repository. Nothing here reads any existing
          repository.
        </p>
      </section>
    </main>
  );
}
