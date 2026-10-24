import Link from "next/link";
import type { PotentialClient } from "@/db/repositories/admin/potential-clients";

/** Long emails and URLs wrap instead of pushing a stacked row off a phone. */
const WRAP = { minWidth: 0, overflowWrap: "anywhere" } as const;

/**
 * People the operator may work with, listed under the real clients.
 *
 * A plain table rather than tiles on purpose: a potential client has no site,
 * analytics or plan to preview, and tiles would make them look like clients.
 */
export function PotentialClientsSection({
  prospects,
}: {
  prospects: PotentialClient[];
}) {
  return (
    <section id="potential-clients" className="card" style={{ marginTop: "2rem" }}>
      <div className="card-head">
        <h2>Potential clients</h2>
        <span className="muted">{prospects.length}</span>
      </div>
      <p className="field-hint" style={{ marginTop: 0 }}>
        Kept apart from your clients: no account, billing, reports or emails
        until you add them as a client.
      </p>

      {prospects.length === 0 ? (
        <p className="muted">Nobody yet. Add someone you&rsquo;re talking to.</p>
      ) : (
        <div className="table-wrap">
          <table className="stack">
            <thead>
              <tr>
                <th>Business</th>
                <th>Contact</th>
                <th>Notes</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {prospects.map((p) => (
                <tr key={p.publicId}>
                  {/* Each cell holds one element: stacked on a phone, a cell is a
                      flex row of its label and its content. */}
                  <td data-label="Business">
                    <div style={WRAP}>
                      <Link href={`/admin/clients/potential/${p.publicId}`}>{p.businessName}</Link>
                      {(p.industry || p.location) && (
                        <div className="muted">
                          {[p.industry, p.location].filter(Boolean).join(" · ")}
                        </div>
                      )}
                      {/* Not a link: an unvetted third-party URL, same as the
                          prospects page. */}
                      {p.sourceWebsiteUrl && (
                        <code style={{ fontSize: "0.8rem", wordBreak: "break-all" }}>
                          {p.sourceWebsiteUrl}
                        </code>
                      )}
                    </div>
                  </td>
                  <td data-label="Contact">
                    {p.contactName || p.contactEmail || p.contactPhone ? (
                      <div style={WRAP}>
                        {p.contactName && <div>{p.contactName}</div>}
                        {p.contactEmail && <div className="muted">{p.contactEmail}</div>}
                        {p.contactPhone && <div className="muted">{p.contactPhone}</div>}
                      </div>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td data-label="Notes" style={{ whiteSpace: "pre-line", ...WRAP }}>
                    {p.notes ?? <span className="muted">—</span>}
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

      <p style={{ marginTop: "1rem" }}>
        <Link className="button" href="/admin/clients/potential/new">
          Add a potential client
        </Link>
      </p>
    </section>
  );
}
