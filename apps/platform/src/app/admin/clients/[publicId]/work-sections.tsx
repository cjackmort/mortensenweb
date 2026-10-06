import type { listBriefs } from "@/db/repositories/admin/briefs";
import { BriefForm, DispatchBriefForm } from "./brief-forms";

const BRIEF_PILL: Record<string, string> = {
  draft: "pill-neutral",
  submitted: "pill-info",
  dispatched: "pill-accent",
  applied: "pill-success",
  cancelled: "pill-neutral",
};

type Brief = Awaited<ReturnType<typeof listBriefs>>[number];

/** Call notes handed to the agent, and what became of each. */
export function BriefsSection({
  clientPublicId,
  sites,
  briefs,
}: {
  clientPublicId: string;
  sites: Array<{ publicId: string; name: string }>;
  briefs: Brief[];
}) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>What they asked for</h2>
        <span className="muted">{briefs.length}</span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Type what came out of the call. Pressing <em>Save and build</em> hands it to the agent,
        which opens a pull request and builds a preview — the client approves that preview before
        anything goes live.
      </p>

      <div className="action-block">
        <BriefForm clientPublicId={clientPublicId} sites={sites} hasSite={sites.length > 0} />
      </div>

      {briefs.length > 0 && (
        <div className="table-wrap">
          <table className="stack">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Summary</th>
                <th>Status</th>
                <th>Written</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {briefs.map((brief) => (
                <tr key={brief.publicId}>
                  <td data-label="Kind">{brief.kind}</td>
                  <td data-label="Summary">
                    {/* First line only. The full text is in the issue, and a
                        wall of call notes in a table row helps nobody. */}
                    {(brief.features ?? brief.colourDirection ?? brief.contentNotes ?? brief.body ?? "")
                      .split("\n")[0]
                      ?.slice(0, 90) || "—"}
                  </td>
                  <td data-label="Status">
                    <span className={`pill ${BRIEF_PILL[brief.status] ?? "pill-neutral"}`}>
                      {brief.status}
                    </span>
                  </td>
                  <td data-label="Written">
                    {brief.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </td>
                  <td data-label="">
                    {brief.status === "draft" && (
                      <DispatchBriefForm briefPublicId={brief.publicId} clientPublicId={clientPublicId} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** The most recent change requests, newest first. */
export function RequestsSection({
  requests,
}: {
  requests: Array<{ publicId: string; title: string; status: string; priority: string }>;
}) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Recent requests</h2>
        <span className="muted">{requests.length}</span>
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
                <th>Title</th>
                <th>Status</th>
                <th>Priority</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((request) => (
                <tr key={request.publicId}>
                  <td data-label="Title">{request.title}</td>
                  <td data-label="Status">{request.status.replace(/_/g, " ")}</td>
                  <td data-label="Priority">{request.priority}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
