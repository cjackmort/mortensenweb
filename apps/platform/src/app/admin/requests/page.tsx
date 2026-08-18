import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { AppShell } from "@/components/app-shell";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import { listAllChangeRequests } from "@/db/repositories/admin/clients";
import { listEscalations } from "@/db/repositories/admin/escalations";
import { isOpen, statusLabel, statusPill } from "@/lib/requests/status";
import { DispatchButton } from "./dispatch-button";

export const dynamic = "force-dynamic";

/**
 * Every client's change requests, in one queue.
 *
 * Sorted newest first and split into open versus settled, because the operator
 * question is "what needs doing" rather than "what has ever been asked". The
 * settled list stays visible but out of the way — history matters when a client
 * asks whether something was ever done.
 */
export default async function AdminRequestsPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role !== "admin") redirect("/dashboard");

  const ctx = adminContextFrom(user);
  const db = await getDb();
  const [all, escalations] = await Promise.all([
    listAllChangeRequests(ctx, db, { limit: 200 }),
    listEscalations(ctx, db),
  ]);

  const open = all.filter((r) => isOpen(r.status));
  const settled = all.filter((r) => !isOpen(r.status));
  const urgent = open.filter(
    (r) => r.priority === "urgent" || r.priority === "high",
  ).length;

  return (
    <AppShell user={user}>
      <main className="shell">
        <div className="masthead">
          <h1>Requests</h1>
          <span className="muted">
            {open.length} open{urgent > 0 && `, ${urgent} high priority`}
          </span>
        </div>

        {/* Above everything else on purpose. These are the only requests where
            the pipeline has stopped and is waiting on a person — burying them
            under a table of things proceeding normally is how one sits for a
            week. Everything needed to start is here, so the queue does not send
            you off to assemble it. */}
        {escalations.length > 0 && (
          <section className="card">
            <div className="card-head">
              <h2>Waiting on you</h2>
              <span className="pill pill-warning">{escalations.length}</span>
            </div>
            <p className="muted" style={{ margin: "0 0 1rem", fontSize: "0.9rem" }}>
              The agent judged these beyond what it should attempt unattended.
              Nothing is broken and nothing has reached a client&rsquo;s site.
            </p>

            {escalations.map((e) => (
              <div key={e.requestPublicId} className="request-item">
                <div className="request-head">
                  <p className="request-title">{e.title}</p>
                  <span className="muted" style={{ fontSize: "0.8rem" }}>
                    {e.organizationName}
                  </span>
                </div>

                {e.reason && (
                  <p style={{ margin: "0.4rem 0" }}>
                    <strong>Blocked on:</strong> {e.reason}
                  </p>
                )}

                {e.description && (
                  <p className="muted" style={{ margin: "0.4rem 0", fontSize: "0.9rem" }}>
                    {e.description}
                  </p>
                )}

                {e.repo ? (
                  <>
                    <p style={{ margin: "0.4rem 0", fontSize: "0.9rem" }}>
                      <a
                        href={`https://github.com/${e.repo}${e.prNumber ? `/pull/${e.prNumber}` : e.issueNumber ? `/issues/${e.issueNumber}` : ""}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {e.repo}
                        {e.prNumber
                          ? ` #${e.prNumber}`
                          : e.issueNumber
                            ? ` issue #${e.issueNumber}`
                            : ""}
                      </a>
                    </p>
                    {/* Copyable rather than clickable: this runs on the
                        operator's own machine under their own Claude
                        subscription, which is the entire point of escalating. */}
                    <pre className="handoff">
                      <code>{`gh repo clone ${e.repo} && cd ${e.repo.split("/")[1]} && claude`}</code>
                    </pre>
                  </>
                ) : (
                  <p className="muted" style={{ fontSize: "0.9rem" }}>
                    No repository is connected to this site yet.
                  </p>
                )}
              </div>
            ))}
          </section>
        )}

        <section className="card">
          <div className="card-head">
            <h2>Needs attention</h2>
          </div>

          {open.length === 0 ? (
            <div className="empty">
              <p className="empty-title">Nothing outstanding.</p>
              <p>Every request has been seen through.</p>
            </div>
          ) : (
            <RequestTable rows={open} />
          )}
        </section>

        {settled.length > 0 && (
          <section className="card">
            <div className="card-head">
              <h2>Settled</h2>
              <span className="muted">{settled.length}</span>
            </div>
            <RequestTable rows={settled} />
          </section>
        )}
      </main>
    </AppShell>
  );
}

function RequestTable({
  rows,
}: {
  rows: Awaited<ReturnType<typeof listAllChangeRequests>>;
}) {
  return (
    <div className="table-wrap">
      <table className="stack">
        <thead>
          <tr>
            <th>Request</th>
            <th>Client</th>
            <th>Status</th>
            <th>Priority</th>
            <th>Sent</th>
            <th>Agent</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.publicId}>
              <td data-label="Request">{r.title}</td>
              <td data-label="Client">{r.organizationName}</td>
              <td data-label="Status">
                <span className={`pill ${statusPill(r.status)}`}>
                  {statusLabel(r.status)}
                </span>
              </td>
              <td data-label="Priority">
                {r.priority === "urgent" || r.priority === "high" ? (
                  <span className="pill pill-warning">{r.priority}</span>
                ) : (
                  <span className="muted">{r.priority}</span>
                )}
              </td>
              <td data-label="Sent">
                {r.createdAt.toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </td>
              <td data-label="Agent">
                <DispatchButton
                  requestPublicId={r.publicId}
                  status={r.status}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
