import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { requireGrowthFeature } from "@/db/repositories/client/growth";
import { listContacts } from "@/db/repositories/client/winback-contacts";
import { formatDateWithYear } from "@/lib/time";
import { removeContactAction } from "../actions";
import { ImportCustomersForm, SyncWonLeadsForm } from "./import-form";
import "../winback.css";

/**
 * The past-customer list: who win-back emails go to, and how each person got
 * there. Everything here is the client's customers' data, so the only things
 * shown are what the client entered or the inbox recorded.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Past customers",
  robots: { index: false, follow: false },
};

const SUPPRESSED: Record<string, string> = {
  unsubscribed: "Unsubscribed",
  bounced: "Address bounced",
  complained: "Marked as spam",
  manual: "Not emailed",
};

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.organizationId) redirect("/dashboard");

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  if (!(await requireGrowthFeature(db, ctx, "winback"))) redirect("/dashboard/growth?locked=winback#winback");
  const page = Math.max(1, Number.parseInt((await searchParams).page ?? "1", 10) || 1);
  const { contacts, hasMore, total, reachable } = await listContacts(db, ctx, { page });
  const readOnly = ctx.impersonating;

  return (
    <main className="shell">
      <p className="lead-back">
        <Link href="/dashboard/growth/winback">← Win-back emails</Link>
      </p>
      <div className="masthead">
        <h1>Past customers</h1>
        <span>
          {total} on your list · {reachable} you can email
        </span>
      </div>

      <section className="panel" aria-labelledby="add-customers">
        <div className="panel-head">
          <h2 id="add-customers">Add customers</h2>
        </div>
        <div className="panel-body">
          <h3 style={{ marginTop: 0 }}>From your leads inbox</h3>
          <p className="muted">
            When you mark an enquiry <strong>Won</strong>, that person is added here straight away. Use this for
            enquiries you marked won before win-back emails were switched on.
          </p>
          <SyncWonLeadsForm readOnly={readOnly} />

          <h3>From a spreadsheet</h3>
          <ImportCustomersForm readOnly={readOnly} />
        </div>
      </section>

      <section className="panel" aria-labelledby="customer-list">
        <div className="panel-head">
          <h2 id="customer-list">Everyone on your list</h2>
        </div>
        {contacts.length === 0 ? (
          <div className="empty">
            <p>Nobody yet. Add customers above.</p>
          </div>
        ) : (
          <div className="panel-body table-wrap">
            <table className="stack">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>How they became a customer</th>
                  <th>Last job</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => (
                  <tr key={c.publicId}>
                    {/* On a phone the name heads the row, where a bare dash read as a glitch. */}
                    <td data-label="Name">{c.name ?? <span className="muted">No name</span>}</td>
                    <td data-label="Email">
                      {c.email}{" "}
                      {c.suppressed && <span className="pill pill-warning">{SUPPRESSED[c.suppressed] ?? c.suppressed}</span>}
                    </td>
                    <td data-label="How">{c.howBecameCustomer}</td>
                    <td data-label="Last job" className="nowrap">
                      {c.lastJobOn ? formatDateWithYear(`${c.lastJobOn}T12:00:00Z`) : "—"}
                    </td>
                    <td data-label="">
                      <form action={removeContactAction}>
                        <input type="hidden" name="contact" value={c.publicId} />
                        <button type="submit" className="secondary small" disabled={readOnly}>
                          Remove
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(page > 1 || hasMore) && (
          <div className="panel-body lead-pager">
            {page > 1 ? <Link href={`?page=${page - 1}`}>← Newer</Link> : <span />}
            {hasMore && <Link href={`?page=${page + 1}`}>Older →</Link>}
          </div>
        )}
        <div className="panel-body">
          <p className="panel-note">
            Someone who unsubscribes, whose address bounces, or who marks an email as spam is never emailed again, even
            if you import them a second time.
          </p>
        </div>
      </section>
    </main>
  );
}
