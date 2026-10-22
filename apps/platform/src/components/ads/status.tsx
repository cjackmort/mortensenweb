import type { CampaignStatus } from "@/db/repositories/client/ads";

/**
 * A campaign's state, said the way the client would say it. The operator's
 * queue uses the same words, so the two sides never describe one campaign
 * differently.
 */
export const STATUS_LABEL: Record<CampaignStatus, string> = {
  draft: "Draft",
  awaiting_payment: "Waiting for payment",
  pending_review: "Being checked",
  rejected: "Needs changes",
  approved: "Starting soon",
  active: "Running",
  paused: "Paused",
  ended: "Ended",
  cancelled: "Cancelled",
};

const TONE: Record<CampaignStatus, string> = {
  draft: "pill-neutral",
  awaiting_payment: "pill-warning",
  pending_review: "pill-info",
  rejected: "pill-danger",
  approved: "pill-info",
  active: "pill-success",
  paused: "pill-warning",
  ended: "pill-neutral",
  cancelled: "pill-neutral",
};

export function CampaignStatusPill({ status }: { status: CampaignStatus }) {
  return <span className={`pill ${TONE[status]}`}>{STATUS_LABEL[status]}</span>;
}

/** What happens next, in one sentence, for the campaign page's header. */
export function statusExplainer(status: CampaignStatus): string {
  switch (status) {
    case "draft":
      return "Nothing is charged and nothing runs until you pay.";
    case "awaiting_payment":
      return "Your checkout is open. The ad goes to us to check once the payment comes through.";
    case "pending_review":
      return "Paid. We check every ad against Google's and Meta's rules before it runs.";
    case "rejected":
      return "We couldn't run this ad as it is. The note below says why.";
    case "approved":
      return "Checked and approved. We're setting it up with Google and Meta.";
    case "active":
      return "Your ad is running.";
    case "paused":
      return "Your ad is paused and not spending.";
    case "ended":
      return "This campaign has finished.";
    case "cancelled":
      return "This campaign was cancelled and did not run.";
  }
}
