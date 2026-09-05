/**
 * The decision to merge.
 *
 * Everything else in the pipeline can be retried or explained away. This is the
 * one point where an automated system writes to a real business's live website,
 * so the guards below are written as *refusals* — the function's job is to find
 * a reason not to merge, and merging is what happens when it cannot find one.
 *
 * Stage 0 §12.3 lists the conditions. Each is implemented here with the reason
 * it exists, because a guard whose purpose is forgotten is a guard that gets
 * removed the first time it is inconvenient.
 *
 * A note on ordering: the cheap local checks run before the network calls, so a
 * pull request that is obviously ineligible costs nothing. But the ordering is
 * not load-bearing for correctness — every check must pass, and none of them
 * short-circuits another's meaning.
 */

import {
  getCombinedStatus,
  getPullRequest,
  listCheckRuns,
  listPullRequestFiles,
  type PullRequest,
  type Repo,
} from "./rest";

export type RefusalReason =
  | "not_open"
  | "draft"
  | "already_merged"
  | "wrong_base"
  | "head_moved"
  | "checks_pending"
  | "checks_failed"
  | "untrusted_author"
  | "paths_out_of_scope"
  | "diff_too_large"
  | "not_approved";

export interface Refusal {
  ok: false;
  reason: RefusalReason;
  /** Operator-facing. Never rendered to a client. */
  detail: string;
}

export interface Permission {
  ok: true;
  headSha: string;
  changedFiles: string[];
}

export type MergeDecision = Permission | Refusal;

const refuse = (reason: RefusalReason, detail: string): Refusal => ({
  ok: false,
  reason,
  detail,
});

/**
 * Authors whose pull requests the pipeline will merge unattended.
 *
 * The point is not that these accounts are trusted in a general sense — it is
 * that a pull request from anyone *else* on a client repository was not
 * produced by the job we dispatched, and merging it would mean this system
 * shipped a change nobody in this system asked for.
 */
function isTrustedAuthor(pr: PullRequest): boolean {
  const login = pr.user?.login?.toLowerCase();
  if (!login) return false;

  const configured = (process.env.AGENT_PR_AUTHORS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  const defaults = ["claude", "claude[bot]", "github-actions[bot]"];
  const allowed = configured.length > 0 ? configured : defaults;

  return allowed.includes(login);
}

/**
 * Does a changed path fall inside the scope the operator set?
 *
 * Prefix matching on a normalised path. `..` is rejected outright rather than
 * resolved: GitHub does not return traversal sequences in `filename`, so one
 * appearing means something is wrong in a way that should stop the merge rather
 * than be tidied up.
 */
export function isPathAllowed(path: string, allowedPaths: string[]): boolean {
  if (allowedPaths.length === 0) return true;
  if (path.includes("..")) return false;

  const normalised = path.replace(/^\.?\//, "");
  return allowedPaths.some((allowed) => {
    const prefix = allowed.replace(/^\.?\//, "").replace(/\/+$/, "");
    if (!prefix) return false;
    // Exact file, or anything beneath a directory. The trailing slash matters:
    // without it, an allowed path of `src/app` would also permit `src/apple`.
    return normalised === prefix || normalised.startsWith(`${prefix}/`);
  });
}

/**
 * Paths that no automated merge may touch, whatever the operator allowed.
 *
 * These are the files that decide what the automation itself is permitted to
 * do. A change request that edits the workflow which runs the agent, or the
 * deployment configuration that decides where the result goes, is a change to
 * the guard rails rather than to the website — so it stops here and waits for a
 * person, every time, with no configuration that can switch it off.
 */
const NEVER_AUTO_MERGE = [
  ".github/",
  "netlify.toml",
  // Netlify's other way of setting headers, for a site that uses it instead of
  // netlify.toml. Guarded for the same reason: it decides who may frame the
  // site, and one permitted answer is the portal, whose grid tile depends on
  // it. A content change has no business editing either.
  "_headers",
  "src/_headers",
  "wrangler.toml",
  "wrangler.jsonc",
  "package.json",
  "package-lock.json",
  "Dockerfile",
];

export function isProtectedPath(path: string): boolean {
  const normalised = path.replace(/^\.?\//, "").toLowerCase();
  return NEVER_AUTO_MERGE.some(
    (guarded) =>
      normalised === guarded.toLowerCase() ||
      normalised.startsWith(guarded.toLowerCase()),
  );
}

export interface GuardInput {
  repo: Repo;
  prNumber: number;
  /**
   * The head SHA recorded when the change was approved. A merge is pinned to
   * exactly this commit.
   */
  approvedHeadSha: string;
  expectedBaseRef: string;
  allowedPaths?: string[];
  /** False short-circuits everything: nothing merges without a decision. */
  clientApproved: boolean;
}

/**
 * Decide whether this pull request may be merged now.
 *
 * Returns the head SHA on success so the caller can pass it to
 * `mergePullRequest`, which refuses with a 409 if the branch has moved in the
 * meantime. That makes the window between this decision and the merge itself
 * closed rather than merely small.
 */
export async function evaluateMerge(input: GuardInput): Promise<MergeDecision> {
  if (!input.clientApproved) {
    return refuse("not_approved", "No client approval is recorded.");
  }

  const pr = await getPullRequest(input.repo, input.prNumber);

  if (pr.merged) {
    return refuse("already_merged", "This pull request is already merged.");
  }
  if (pr.state !== "open") {
    return refuse("not_open", `Pull request is ${pr.state}.`);
  }
  if (pr.draft) {
    return refuse("draft", "Pull request is still a draft.");
  }
  if (pr.base.ref !== input.expectedBaseRef) {
    return refuse(
      "wrong_base",
      `Targets ${pr.base.ref}, expected ${input.expectedBaseRef}.`,
    );
  }
  if (!isTrustedAuthor(pr)) {
    return refuse(
      "untrusted_author",
      `Opened by ${pr.user?.login ?? "an unknown account"}, which is not an agent account.`,
    );
  }

  // The commit the client actually looked at. Anything else is a different
  // change wearing the same pull request number.
  if (pr.head.sha !== input.approvedHeadSha) {
    return refuse(
      "head_moved",
      "New commits were pushed after approval, so what was approved is no longer what would merge.",
    );
  }

  const { files, truncated } = await listPullRequestFiles(
    input.repo,
    input.prNumber,
  );

  // A diff we could not read in full is an *unknown* diff. Treating a partial
  // file list as complete would silently narrow every path check below it.
  if (truncated) {
    return refuse(
      "diff_too_large",
      "The pull request changes more files than the guard will read. Review it by hand.",
    );
  }

  const changedFiles: string[] = [];
  for (const file of files) {
    // A rename has two paths and both must be in scope — otherwise a file could
    // be moved *out of* the allowed area, or in from outside it.
    const paths = [file.filename, file.previous_filename].filter(
      (value): value is string => Boolean(value),
    );

    for (const path of paths) {
      if (isProtectedPath(path)) {
        return refuse(
          "paths_out_of_scope",
          `${path} controls the automation itself and is never merged unattended.`,
        );
      }
      if (!isPathAllowed(path, input.allowedPaths ?? [])) {
        return refuse(
          "paths_out_of_scope",
          `${path} is outside the paths this request was scoped to.`,
        );
      }
    }

    changedFiles.push(file.filename);
  }

  // Checks and commit statuses are two separate systems, and a repository can
  // report through either. Reading only one is how a red build gets merged.
  const [checkRuns, combined] = await Promise.all([
    listCheckRuns(input.repo, pr.head.sha),
    getCombinedStatus(input.repo, pr.head.sha),
  ]);

  const failed = checkRuns.filter(
    (run) =>
      run.status === "completed" &&
      run.conclusion !== null &&
      !["success", "neutral", "skipped"].includes(run.conclusion),
  );
  if (failed.length > 0) {
    return refuse(
      "checks_failed",
      `Failing checks: ${failed.map((run) => run.name).join(", ")}.`,
    );
  }
  if (combined.total > 0 && combined.state === "failure") {
    return refuse("checks_failed", "A commit status reports failure.");
  }

  const pending = checkRuns.filter((run) => run.status !== "completed");
  if (pending.length > 0) {
    return refuse(
      "checks_pending",
      `Still running: ${pending.map((run) => run.name).join(", ")}.`,
    );
  }
  if (combined.total > 0 && combined.state === "pending") {
    return refuse("checks_pending", "A commit status is still pending.");
  }

  return { ok: true, headSha: pr.head.sha, changedFiles };
}

/**
 * What to tell the client when a merge is refused.
 *
 * Deliberately vague where the reason is internal. "Opened by an untrusted
 * account" describes our security model, not their website, and a client can do
 * nothing with it except worry. The operator sees `detail`; the client sees
 * this.
 */
export function clientFacingRefusal(reason: RefusalReason): string {
  switch (reason) {
    case "checks_pending":
      return "We're still running the final checks on this change. It'll go live shortly.";
    case "checks_failed":
      return "A check didn't pass on this change, so we've held it for review. We'll be in touch.";
    case "head_moved":
      return "This change was updated after you approved it, so we've asked you to take another look.";
    case "already_merged":
      return "This change is already live.";
    case "not_approved":
      return "This change is waiting for your approval.";
    default:
      return "We've held this change for a human to review before it goes live.";
  }
}
