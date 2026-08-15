import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import {
  listChangeRequests,
  listSites,
} from "@/db/repositories/client/change-requests";

export const dynamic = "force-dynamic";

/**
 * Client dashboard.
 *
 * Every query goes through a `TenantContext` built from the session's own
 * organization. There is no code path here that could read another client's
 * data, and nothing on this page can reach the Potential Clients area.
 */
export default async function ClientDashboard() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");

  if (!user.organizationId) {
    return (
      <main className="shell">
        <div className="masthead">
          <h1>Mortensen Web Co.</h1>
          <span className="muted">{user.email}</span>
        </div>
        <p className="notice">
          Your account is not yet linked to an organization. Please contact us
          and we will finish setting it up.
        </p>
      </main>
    );
  }

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();

  const [sites, requests] = await Promise.all([
    listSites(db, ctx),
    listChangeRequests(db, ctx, { limit: 20 }),
  ]);

  return (
    <main className="shell">
      <div className="masthead">
        <h1>Your website</h1>
        <span className="muted">{user.email}</span>
      </div>

      <section className="card">
        <h2>Sites</h2>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Domain</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {sites.map((s) => (
              <tr key={s.publicId}>
                <td>{s.name}</td>
                <td className="muted">{s.primaryDomain ?? "—"}</td>
                <td>{s.status}</td>
              </tr>
            ))}
            {sites.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  No sites yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Your requests</h2>
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Status</th>
              <th>Priority</th>
              <th>Submitted</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((r) => (
              <tr key={r.publicId}>
                <td>{r.title}</td>
                <td>{r.status}</td>
                <td>{r.priority}</td>
                <td className="muted">
                  {new Date(r.createdAt).toLocaleDateString("en-US", {
                    timeZone: "America/Denver",
                  })}
                </td>
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
    </main>
  );
}
