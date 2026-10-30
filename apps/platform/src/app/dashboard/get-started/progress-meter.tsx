/**
 * How far through Get started a client is, as a bar.
 *
 * The compact one sits inside the home-page banner, whose text already says
 * "3 of 8 done", so it is hidden from screen readers rather than read twice.
 */
export function ProgressMeter({ done, total, compact = false }: { done: number; total: number; compact?: boolean }) {
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const bar = <span style={{ width: `${percent}%` }} />;

  if (compact) {
    return (
      <span className="todo-meter todo-meter--compact" aria-hidden="true">
        {bar}
      </span>
    );
  }
  return (
    <div
      className="todo-meter"
      role="progressbar"
      aria-label="Get started progress"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-valuetext={`${done} of ${total} done`}
    >
      {bar}
    </div>
  );
}
