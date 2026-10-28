import type { ListingProgress } from "@/lib/listings/steps";

/** "5 of 8 done", with a bar for anyone skimming. */
export function ListingProgressLine({ progress }: { progress: ListingProgress }) {
  const percent = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);
  return (
    <div className="listing-progress">
      <p className="muted" style={{ margin: 0 }}>
        <strong>{progress.label}</strong>
      </p>
      <div
        className="listing-progress-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.done}
        aria-label="Listings done"
      >
        <span style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
