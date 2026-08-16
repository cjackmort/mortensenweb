import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { AppShell } from "@/components/app-shell";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import { listProspects } from "@/db/repositories/admin/clients";

export const dynamic = "force-dynamic";

const PROSPECT_PILL: Record<string, string> = {
  discovered: "pill-neutral",
  audited: "pill-info",
  concept_generated: "pill-accent",
  contacted: "pill-warning",
  responded: "pill-accent",
  converted: "pill-success",
  rejected: "pill-neutral",
  archived: "pill-neutral",
};

/**
 * Potential clients.
 *
 * Admin-only by construction: there is no client-facing repository anywhere in
 * the codebase that reads the `prospects` table, so this data cannot leak into
 * a tenant surface even by mistake.
 *
 * Read-only for now. The concept-generation pipeline that fills this table is
 * Stage 3 proper — crawling a prospect's existing site, generating a concept,
 * and tracking outreach. What exists today is the table and its status field,
 * so this page shows what is there rather than pretending to more.
 */
export default async function AdminProspectsPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role !== "admin") redirect("/dashboard");

  const ctx = adminContextFrom(user);
  const db = await getDb();
  const prospects = await listProspects(ctx, db);

  return (
    <AppShell user={user}>
      <main className="shell">
        <div className="masthead">
          <h1>Potential clients</h1>
          <span className="muted">{prospects.length}</span>
        </div>

        <section className="card">
          {prospects.length === 0 ? (
            <div className="empty">
              <p className="empty-title">No prospects yet.</p>
              <p>
                Businesses you&rsquo;re considering approaching appear here once
                the outreach pipeline is built.
              </p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="stack">
                <thead>
                  <tr>
                    <th>Business</th>
                    <th>Current site</th>
                    <th>Industry</th>
                    <th>Status</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {prospects.map((p) => (
                    <tr key={p.publicId}>
                      <td data-label="Business">
                        {p.businessName}
                        {p.isDemo && (
                          <>
                            {" "}
                            <span className="badge">demo</span>
                          </>
                        )}
                      </td>
                      <td data-label="Current site">
                        {p.sourceWebsiteUrl ? (
                          // Not a link: these are unvetted third-party URLs
                          // taken from crawled data, and a one-click path from
                          // an admin session to an arbitrary site is a needless
                          // risk. Copy it if you want to visit.
                          <code style={{ fontSize: "0.8rem" }}>
                            {p.sourceWebsiteUrl}
                          </code>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td data-label="Industry">{p.industry ?? "—"}</td>
                      <td data-label="Status">
                        <span
                          className={`pill ${PROSPECT_PILL[p.status] ?? "pill-neutral"}`}
                        >
                          {p.status.replace(/_/g, " ")}
                        </span>
                      </td>
                      <td data-label="Updated">
                        {p.updatedAt.toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
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
