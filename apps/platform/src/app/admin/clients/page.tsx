import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { AppShell } from "@/components/app-shell";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import { listClients } from "@/db/repositories/admin/clients";

export const dynamic = "force-dynamic";

/**
 * The client list, and the way into every per-client action.
 *
 * Gated twice like every admin surface: the page check below, and
 * `adminContextFrom`, which refuses a session that is not an active admin.
 */
export default async function AdminClientsPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role !== "admin") redirect("/dashboard");

  const ctx = adminContextFrom(user);
  const db = await getDb();
  const clients = await listClients(ctx, db);

  return (
    <AppShell user={user}>
      <main className="shell">
        <div className="masthead">
          <h1>Clients</h1>
          <div className="actions">
            <span className="muted" style={{ alignSelf: "center" }}>
              {clients.length} {clients.length === 1 ? "client" : "clients"}
            </span>
            <Link className="button" href="/admin/clients/new">
              Add a client
            </Link>
          </div>
        </div>

        <section className="card">
          {clients.length === 0 ? (
            <div className="empty">
              <p className="empty-title">No clients yet.</p>
              <p>
                Add one to create their record. Issuing their portal
                credentials is a separate step on their own page.
              </p>
              <p style={{ marginTop: "1rem" }}>
                <Link className="button" href="/admin/clients/new">
                  Add a client
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
                    <th>Added</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map((c) => (
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
                        {c.primaryContactEmail && (
                          <div className="muted" style={{ fontSize: "0.82rem" }}>
                            {c.primaryContactEmail}
                          </div>
                        )}
                      </td>
                      <td data-label="Industry">{c.industry ?? "—"}</td>
                      <td data-label="Added">
                        {c.createdAt.toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </AppShell>
  );
}
