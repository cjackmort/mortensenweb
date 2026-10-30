import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import { listAllShowcases, type AdminShowcaseRow } from "@/db/repositories/admin/showcases";
import { formatDate } from "@/lib/time";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Showcases",
  robots: { index: false, follow: false },
};

/**
 * Every client's job showcases, newest first.
 *
 * The site pages themselves are worked in Requests, like any change; this is
 * where a stuck one shows up — waiting on another change, out of changes for
 * the month, or a Google post nobody has pasted yet.
 */
export default async function AdminShowcasesPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role !== "admin") redirect("/dashboard");

  const ctx = adminContextFrom(user);
  const db = await getDb();
  const rows = await listAllShowcases(ctx, db);
  const waiting = rows.filter((r) => r.site.state === "blocked").length;

  return (
    <main className="shell">
      <div className="masthead">
        <h1>Showcases</h1>
        <span className="muted">
          {rows.length} {rows.length === 1 ? "job" : "jobs"}
          {waiting > 0 && `, ${waiting} with a website page that could not be sent`}
        </span>
      </div>

      {rows.length === 0 ? (
        <section className="card">
          <p className="muted">No client has made a showcase yet.</p>
        </section>
      ) : (
        <ShowcaseTable rows={rows} />
      )}
    </main>
  );
}

/** In a card like every other admin table, not loose on the page's ground. */
function ShowcaseTable({ rows }: { rows: AdminShowcaseRow[] }) {
  return (
    <section className="card">
      <div className="table-wrap">
        <table className="stack">
          <thead>
            <tr>
              <th>Job</th>
              <th>Client</th>
              <th>Website page</th>
              <th>Google</th>
              <th>Made</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.publicId}>
                <td data-label="Job">
                  {r.title}
                  <span className="muted">
                    {" "}
                    · {r.town} · {r.photoCount} {r.photoCount === 1 ? "photo" : "photos"}
                  </span>
                </td>
                <td data-label="Client">
                  {r.clientPublicId ? (
                    <Link href={`/admin/clients/${r.clientPublicId}`}>{r.organizationName}</Link>
                  ) : (
                    r.organizationName
                  )}
                </td>
                <td data-label="Website page">
                  {r.status === "draft" ? (
                    <span className="pill pill-neutral">Wording not approved</span>
                  ) : (
                    <>
                      <span className={`pill ${r.site.state === "live" ? "pill-success" : r.site.state === "blocked" || r.site.state === "stopped" ? "pill-warning" : "pill-info"}`}>
                        {r.site.label}
                      </span>
                      {r.site.state === "blocked" && <span className="queue-note">{r.site.detail}</span>}
                      {r.requestTitle && (
                        <span className="queue-note">
                          <Link href="/admin/requests">{r.requestTitle}</Link>
                        </span>
                      )}
                    </>
                  )}
                </td>
                <td data-label="Google">{r.status === "draft" ? <span className="muted">—</span> : r.google.label}</td>
                <td data-label="Made" className="nowrap">
                  {formatDate(r.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
