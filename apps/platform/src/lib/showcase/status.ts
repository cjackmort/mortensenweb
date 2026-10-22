/**
 * What each of a showcase's outputs says to the client.
 *
 * The site page is read from its change request, so it can never claim more
 * than the pipeline knows: "Preview ready" waits for the operator to release
 * the preview (the same rule the Requests page follows), and "Live" waits for
 * the deploy rather than the merge.
 */

export type SiteBlockedReason =
  | "no_site"
  | "locked"
  | "one_at_a_time"
  | "allowance_exhausted"
  | "photos_not_ready"
  | "failed";

export type SiteState = "not_sent" | "blocked" | "waiting" | "preview_ready" | "live" | "stopped";

export interface SiteOutput {
  state: SiteState;
  label: "Not sent" | "Waiting" | "Preview ready" | "Live" | "Not published";
  detail: string;
  /** Whether "Send to my website" should be offered. */
  canSend: boolean;
}

export const BLOCKED_DETAIL: Record<SiteBlockedReason, string> = {
  no_site: "Your website isn't set up in the portal yet, so there's nowhere to put the page. We'll be in touch.",
  locked: "Website changes start once your first payment goes through.",
  one_at_a_time:
    "Another change is in progress on your website. We do one at a time, so send this once that one is live.",
  allowance_exhausted: "You've used this month's website changes. Send it again when they reset.",
  photos_not_ready: "A photo is still being prepared. Give it a minute and send it again.",
  failed: "Something went wrong sending it. Please try again.",
};

const LIVE = new Set(["deployed", "verified"]);
const STOPPED = new Set(["closed", "rejected", "rolled_back"]);

export function isSiteBlockedReason(value: unknown): value is SiteBlockedReason {
  return typeof value === "string" && value in BLOCKED_DETAIL;
}

export function siteOutput(input: {
  approved: boolean;
  blockedReason: string | null;
  request: { status: string; previewReleased: boolean } | null;
}): SiteOutput {
  if (!input.approved) {
    return { state: "not_sent", label: "Not sent", detail: "Approve the write-up to send it to your website.", canSend: false };
  }

  const { request } = input;
  if (!request) {
    if (isSiteBlockedReason(input.blockedReason)) {
      return { state: "blocked", label: "Waiting", detail: BLOCKED_DETAIL[input.blockedReason], canSend: true };
    }
    return { state: "not_sent", label: "Not sent", detail: "Not sent to your website yet.", canSend: true };
  }

  if (LIVE.has(request.status)) {
    return { state: "live", label: "Live", detail: "The page is on your website.", canSend: false };
  }
  if (STOPPED.has(request.status)) {
    return {
      state: "stopped",
      label: "Not published",
      detail: "That change was stopped before it went live. Send it again if you still want the page.",
      canSend: true,
    };
  }
  if (request.status === "merged") {
    return { state: "waiting", label: "Waiting", detail: "Approved. It's going live now.", canSend: false };
  }
  if (request.status === "pr_open" && request.previewReleased) {
    return {
      state: "preview_ready",
      label: "Preview ready",
      detail: "Have a look under Requests, then approve it to put it live.",
      canSend: false,
    };
  }
  if (request.status === "failed" || request.status === "needs_operator") {
    return { state: "waiting", label: "Waiting", detail: "We hit a snag building the page. A person is looking at it.", canSend: false };
  }
  return {
    state: "waiting",
    label: "Waiting",
    detail: "We're making the page. You'll see a preview before anything changes.",
    canSend: false,
  };
}

export type GoogleState = "none" | "manual" | "posted" | "failed";

export interface GoogleOutput {
  state: GoogleState;
  label: "—" | "Post manually" | "Posted" | "Didn't post";
}

export function googleOutput(status: string | null): GoogleOutput {
  switch (status) {
    case "manual":
      return { state: "manual", label: "Post manually" };
    case "posted":
      return { state: "posted", label: "Posted" };
    case "failed":
      return { state: "failed", label: "Didn't post" };
    default:
      return { state: "none", label: "—" };
  }
}
