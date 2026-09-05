import type { TimelineEntry } from "@/db/repositories/client/change-requests";
import { formatDateTime } from "@/lib/time";

/**
 * The story of a request, under its progress track.
 *
 * The track says how far along a change is; this says what actually happened
 * and when — including the agent's own description of what it changed, which
 * used to live only in a pull request the client never sees. Each line is
 * the event's stored, client-facing wording; the kinds below only decide the
 * label and whether the entry is one the client wrote.
 *
 * Folded by default. The track answers the common question; the story is for
 * the client who wants to know why "needs your approval" took an hour, and
 * for the operator explaining it.
 */

const LABELS: Record<string, string> = {
  submitted: "Sent",
  work_started: "Work started",
  change_drafted: "Change made",
  agent_summary: "What we changed",
  preview_ready: "Preview ready",
  preview_updated: "Preview updated",
  preview_released: "Preview released",
  preview_approved: "You approved it",
  changes_requested: "You asked for changes",
  client_note: "Your note",
  escalated_notice: "A person took over",
  change_applied: "Published",
  change_verified: "Confirmed live",
  request_cancelled: "Cancelled",
  request_closed: "Closed",
  notification_sent: "Emailed you",
};

function label(kind: string): string {
  return LABELS[kind] ?? kind.replaceAll("_", " ");
}

export function RequestTimeline({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) return null;

  const summary = entries.find((e) => e.kind === "agent_summary");

  return (
    <div className="timeline-wrap">
      {/* The agent's summary is the one entry worth showing unfolded: it is
          what the client is being asked to approve, in words. */}
      {summary?.body && (
        <div className="timeline-summary">
          <p className="timeline-summary-label">What we changed</p>
          <p className="timeline-summary-body">{summary.body}</p>
        </div>
      )}

      <details className="timeline">
        <summary>
          What happened
          <span className="muted"> · {entries.length} updates</span>
        </summary>
        <ol className="timeline-list">
          {entries.map((e, i) => (
            <li
              key={`${e.kind}-${i}`}
              className={e.actorType === "client" ? "is-client" : undefined}
            >
              <span className="timeline-dot" aria-hidden="true" />
              <div>
                <p className="timeline-head">
                  <span className="timeline-label">{label(e.kind)}</span>
                  <time
                    className="muted"
                    dateTime={new Date(e.createdAt).toISOString()}
                  >
                    {formatDateTime(e.createdAt)}
                  </time>
                </p>
                {e.body && e.kind !== "agent_summary" && (
                  <p className="timeline-body">{e.body}</p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
