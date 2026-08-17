/**
 * Change-request status presentation.
 *
 * Shared because two pages render these and both had invented the value names
 * independently — `completed`, `declined`, `cancelled` are not in the enum, so
 * every pill silently fell back to grey and every "still open" count was wrong.
 * A single mapping keyed off the real enum makes that class of drift impossible.
 *
 * The enum lives in `db/schema/enums.ts` as `change_request_status`.
 */

export type ChangeRequestStatus =
  | "submitted"
  | "triaged"
  | "in_progress"
  | "approved"
  | "rejected"
  | "dispatched"
  | "pr_open"
  | "changes_requested"
  | "merged"
  | "deployed"
  | "verified"
  | "closed"
  | "failed"
  | "rolled_back";

/**
 * States where nothing further is expected from us.
 *
 * `deployed` is deliberately NOT terminal: the change is live but unverified,
 * and telling a client it is finished before anyone has checked is how a broken
 * deploy goes unnoticed.
 */
export const SETTLED_STATUSES = [
  "verified",
  "closed",
  "rejected",
  "rolled_back",
] as const satisfies readonly ChangeRequestStatus[];

const SETTLED: ReadonlySet<string> = new Set<ChangeRequestStatus>(
  SETTLED_STATUSES,
);

export function isOpen(status: string): boolean {
  return !SETTLED.has(status);
}

/**
 * Statuses where the change is already on its way to the live site.
 *
 * `merged` counts: the commit is on the default branch and the deploy is
 * running, so there is nothing left to call off. Undoing it is a rollback,
 * which is a different operation with a different conversation attached.
 */
const TOO_LATE_TO_CANCEL: ReadonlySet<string> = new Set<ChangeRequestStatus>([
  "merged",
  "deployed",
]);

/**
 * May the client call this off themselves?
 *
 * Exported so the button and the server action decide from the same rule. A
 * button offered for something the server will refuse is worse than no button.
 */
export function isCancellable(status: string): boolean {
  return !SETTLED.has(status) && !TOO_LATE_TO_CANCEL.has(status);
}

export function isTooLateToCancel(status: string): boolean {
  return TOO_LATE_TO_CANCEL.has(status);
}

export function openCount(rows: { status: string }[]): number {
  return rows.filter((r) => isOpen(r.status)).length;
}

const PILL: Record<ChangeRequestStatus, string> = {
  submitted: "pill-info",
  triaged: "pill-info",
  in_progress: "pill-accent",
  approved: "pill-accent",
  dispatched: "pill-accent",
  pr_open: "pill-accent",
  changes_requested: "pill-warning",
  merged: "pill-accent",
  deployed: "pill-info",
  verified: "pill-success",
  closed: "pill-neutral",
  rejected: "pill-neutral",
  failed: "pill-danger",
  rolled_back: "pill-danger",
};

export function statusPill(status: string): string {
  return PILL[status as ChangeRequestStatus] ?? "pill-neutral";
}

/**
 * Client-facing wording.
 *
 * The raw enum is engineering vocabulary — a client should not have to work out
 * what `pr_open` or `rolled_back` means about their website.
 */
const LABEL: Record<ChangeRequestStatus, string> = {
  submitted: "received",
  triaged: "queued",
  in_progress: "being worked on",
  approved: "approved",
  dispatched: "being worked on",
  pr_open: "in review",
  changes_requested: "needs your input",
  merged: "ready to publish",
  deployed: "published, checking",
  verified: "done",
  closed: "closed",
  rejected: "not going ahead",
  failed: "problem — we're on it",
  rolled_back: "undone",
};

export function statusLabel(status: string): string {
  return LABEL[status as ChangeRequestStatus] ?? status.replace(/_/g, " ");
}

/**
 * Progress, as the client experiences it.
 *
 * The enum has fourteen states because that is what the automation pipeline
 * needs. A client asking "has my change happened yet?" needs five. These stages
 * collapse the pipeline into that question without lying about it — note that
 * `deployed` reaches "Published" but not "Confirmed live", because the change
 * is on the site and nobody has checked it yet. Merging those two would let a
 * broken deploy report itself as finished.
 *
 * "Needs your approval" is its own stage rather than part of "being worked on"
 * because it is the one step where the pipeline is waiting on the *client*. A
 * client who cannot tell the difference between "we're building it" and "we're
 * waiting on you" leaves previews sitting unapproved, which is the single
 * slowest link in the loop.
 */
export const STAGES = [
  "Received",
  "Making preview",
  "Needs your approval",
  "Published",
  "Confirmed live",
] as const;

const STAGE_OF: Record<ChangeRequestStatus, number> = {
  submitted: 0,
  triaged: 0,
  approved: 1,
  dispatched: 1,
  in_progress: 1,
  // Back to building: the client has seen it and asked for something different,
  // so the next thing to happen is another preview, not another approval.
  changes_requested: 1,
  pr_open: 2,
  // Approved and merged, with the deploy running. Sitting at "needs your
  // approval" would ask again for a decision already made; claiming "confirmed
  // live" would skip the check that catches a broken deploy.
  merged: 3,
  deployed: 3,
  verified: 4,
  closed: 4,
  // Off-track states have no position on the track; see `isOffTrack`.
  rejected: -1,
  failed: -1,
  rolled_back: -1,
};

/**
 * States that are not a point on the happy path.
 *
 * Rendering these as a part-filled progress bar would imply the change is still
 * coming. It is not, and saying so plainly is the whole point.
 */
export function isOffTrack(status: string): boolean {
  return (STAGE_OF[status as ChangeRequestStatus] ?? -1) < 0;
}

/** Index into `STAGES`, or null when the request is off-track. */
export function stageIndex(status: string): number | null {
  const index = STAGE_OF[status as ChangeRequestStatus];
  return index === undefined || index < 0 ? null : index;
}

/** One line answering "has it taken effect?" */
export function effectSummary(status: string): string {
  switch (status as ChangeRequestStatus) {
    // Sits at the "Published" stage with the deploy still running, so it needs
    // its own line: the default "Not on your site yet" would contradict the
    // track, and the `deployed` wording would claim a build that has not landed.
    case "merged":
      return "You approved this — it's publishing to your site now.";
    case "pr_open":
      return "Ready for you to look at. Nothing changes on your site until you approve it.";
    case "deployed":
      return "This is live on your site now. We're giving it a final check.";
    case "verified":
    case "closed":
      return "Live on your site and checked.";
    case "changes_requested":
      return "We need something from you before this can go ahead.";
    case "rejected":
      return "We're not going ahead with this one.";
    case "rolled_back":
      return "This was undone after it went live.";
    case "failed":
      return "Something went wrong publishing this. We're on it.";
    default:
      return "Not on your site yet.";
  }
}
