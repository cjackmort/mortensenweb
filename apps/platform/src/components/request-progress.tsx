import {
  STAGES,
  effectSummary,
  isOffTrack,
  statusLabel,
} from "@/lib/requests/status";

/**
 * "Has my change happened yet?" — answered without making the client interpret
 * pipeline vocabulary.
 *
 * Two renderings, because two situations. On the happy path a five-step track
 * shows how far along the change is. Off it — rejected, failed, rolled back —
 * the track is replaced entirely, since a part-filled progress bar would
 * suggest the change is still on its way when it is not.
 *
 * Stage names are never colour-only: each carries a text label and the current
 * one is marked with `aria-current`, so the state survives colourblindness and
 * a screen reader alike.
 */
export function RequestProgress({
  status,
  stage,
}: {
  status: string;
  stage: number | null;
}) {
  if (isOffTrack(status) || stage === null) {
    return (
      <div className="progress-offtrack">
        <span className="pill pill-danger">{statusLabel(status)}</span>
        <span>{effectSummary(status)}</span>
      </div>
    );
  }

  return (
    <>
      <ol className="progress" aria-label="Progress">
        {STAGES.map((label, index) => {
          const done = index < stage;
          const current = index === stage;
          return (
            <li
              key={label}
              className={done ? "is-done" : current ? "is-current" : "is-todo"}
              aria-current={current ? "step" : undefined}
            >
              <span className="progress-dot" aria-hidden="true" />
              <span className="progress-label">{label}</span>
            </li>
          );
        })}
      </ol>
      <p className="progress-summary">{effectSummary(status)}</p>
    </>
  );
}
