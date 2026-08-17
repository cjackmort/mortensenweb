/**
 * The REST surface the pipeline actually uses.
 *
 * Deliberately hand-rolled rather than Octokit: this ships inside a Cloudflare
 * Worker, the pipeline needs six endpoints, and Octokit's plugin graph is a
 * large dependency to carry for that. Each function below is the narrow shape
 * the caller needs, with the response fields we rely on named explicitly — so a
 * change in what we depend on is a compile error, not a runtime surprise.
 */

import { githubRequest } from "./app";

export interface Repo {
  installationId: string;
  owner: string;
  name: string;
}

const repoPath = (repo: Repo) =>
  `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export interface CreatedIssue {
  number: number;
  html_url: string;
  node_id: string;
}

export async function createIssue(
  repo: Repo,
  input: { title: string; body: string; labels?: string[] },
): Promise<CreatedIssue> {
  const { data } = await githubRequest<CreatedIssue>(
    repo.installationId,
    `${repoPath(repo)}/issues`,
    { method: "POST", body: input },
  );
  return data;
}

export async function commentOnIssue(
  repo: Repo,
  issueNumber: number,
  body: string,
): Promise<void> {
  await githubRequest(
    repo.installationId,
    `${repoPath(repo)}/issues/${issueNumber}/comments`,
    { method: "POST", body: { body } },
  );
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export interface PullRequest {
  number: number;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  mergeable_state: string;
  html_url: string;
  title: string;
  head: { sha: string; ref: string };
  base: { ref: string };
  user: { login: string; type: string } | null;
}

export async function getPullRequest(
  repo: Repo,
  number: number,
): Promise<PullRequest> {
  const { data } = await githubRequest<PullRequest>(
    repo.installationId,
    `${repoPath(repo)}/pulls/${number}`,
  );
  return data;
}

export interface ChangedFile {
  filename: string;
  /** Present when a file was moved; the guard must consider both paths. */
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
}

/**
 * Every file the pull request touches.
 *
 * Paginated at 100 per page and followed to the end: a partial file list would
 * silently narrow the safe-path check, which is exactly the check that decides
 * whether a change merges unattended. Failing closed on a large diff is the
 * point of the cap below.
 */
export async function listPullRequestFiles(
  repo: Repo,
  number: number,
  { maxPages = 10 }: { maxPages?: number } = {},
): Promise<{ files: ChangedFile[]; truncated: boolean }> {
  const files: ChangedFile[] = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const { data } = await githubRequest<ChangedFile[]>(
      repo.installationId,
      `${repoPath(repo)}/pulls/${number}/files?per_page=100&page=${page}`,
    );
    if (!data || data.length === 0) return { files, truncated: false };
    files.push(...data);
    if (data.length < 100) return { files, truncated: false };
  }

  // More pages remain than we were willing to read. The caller must treat this
  // as "unknown diff", never as "no further changes".
  return { files, truncated: true };
}

export interface MergeResult {
  merged: boolean;
  status: number;
  message?: string;
  sha?: string;
}

/**
 * Merge, pinned to an expected head SHA.
 *
 * `sha` is not optional in our usage: GitHub refuses the merge with 409 if the
 * branch has moved since we looked. That turns "someone pushed a commit between
 * the guard check and the merge call" from a race into a refusal.
 */
export async function mergePullRequest(
  repo: Repo,
  number: number,
  input: { sha: string; commitTitle?: string; mergeMethod?: "merge" | "squash" | "rebase" },
): Promise<MergeResult> {
  const { status, data } = await githubRequest<{ merged?: boolean; message?: string; sha?: string }>(
    repo.installationId,
    `${repoPath(repo)}/pulls/${number}/merge`,
    {
      method: "PUT",
      body: {
        sha: input.sha,
        commit_title: input.commitTitle,
        merge_method: input.mergeMethod ?? "squash",
      },
      // 405 = not mergeable, 409 = head moved. Both are expected outcomes of a
      // guarded merge attempt and are reported, not thrown.
      allowStatuses: [405, 409],
    },
  );

  return {
    merged: status === 200 && Boolean(data?.merged),
    status,
    message: data?.message,
    sha: data?.sha,
  };
}

// ---------------------------------------------------------------------------
// Repository provisioning
// ---------------------------------------------------------------------------

export interface CreatedRepo {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
}

/**
 * Create a repository from the template repository.
 *
 * Templates rather than a fresh repo plus a tree of `createFile` calls: one API
 * call instead of dozens, the workflow file and branch protection settings come
 * along, and — the part that actually matters — what gets scaffolded is
 * reviewable in one place as a normal repository, rather than being assembled
 * from string literals in this codebase.
 *
 * `private: true` is not defaulted, it is passed explicitly on every call. A
 * prospect's concept repository going public would expose an unapproved
 * mock-up of a business that has not agreed to anything, and the schema already
 * refuses a non-private `concept_repositories` row with a check constraint. The
 * two guards are deliberate duplication.
 */
export async function createRepoFromTemplate(
  installationId: string,
  template: { owner: string; name: string },
  input: {
    owner: string;
    name: string;
    description?: string;
    private: boolean;
  },
): Promise<CreatedRepo> {
  const { data } = await githubRequest<CreatedRepo>(
    installationId,
    `/repos/${encodeURIComponent(template.owner)}/${encodeURIComponent(template.name)}/generate`,
    {
      method: "POST",
      body: {
        owner: input.owner,
        name: input.name,
        description: input.description,
        private: input.private,
        // Without the template's history, `git log` in a scaffolded repo starts
        // at the client's own first change, which is what anyone reading it
        // later expects to see.
        include_all_branches: false,
      },
    },
  );

  return data;
}

export async function getRepo(
  installationId: string,
  owner: string,
  name: string,
): Promise<CreatedRepo | null> {
  const { status, data } = await githubRequest<CreatedRepo>(
    installationId,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    { allowStatuses: [404] },
  );
  return status === 404 ? null : data;
}

/**
 * Set a repository Actions **variable** — plaintext, not a secret.
 *
 * This is how a scaffolded repository learns its Netlify site id. The
 * distinction from a secret is the entire reason the pipeline can provision
 * repositories without a crypto dependency: Actions *secrets* must be sealed
 * client-side with libsodium's `crypto_box_seal`, which WebCrypto cannot do, so
 * writing one from here would mean bundling libsodium to encrypt a value that
 * is not confidential.
 *
 * A Netlify site id is a public identifier — it appears in deploy URLs and
 * build logs — so it belongs in a variable. Anything genuinely secret
 * (`NETLIFY_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`) is set once at the account
 * level by hand and inherited, and never passes through this code.
 */
export async function setRepoVariable(
  repo: Repo,
  name: string,
  value: string,
): Promise<void> {
  // POST creates; it 409s if the variable already exists, in which case PATCH
  // updates it. There is no upsert endpoint.
  const { status } = await githubRequest(
    repo.installationId,
    `${repoPath(repo)}/actions/variables`,
    { method: "POST", body: { name, value }, allowStatuses: [409] },
  );

  if (status === 409) {
    await githubRequest(
      repo.installationId,
      `${repoPath(repo)}/actions/variables/${encodeURIComponent(name)}`,
      { method: "PATCH", body: { name, value } },
    );
  }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export interface CheckRun {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion:
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "timed_out"
    | "action_required"
    | "stale"
    | "skipped"
    | null;
}

export async function listCheckRuns(
  repo: Repo,
  ref: string,
): Promise<CheckRun[]> {
  const { data } = await githubRequest<{ check_runs: CheckRun[] }>(
    repo.installationId,
    `${repoPath(repo)}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
  );
  return data?.check_runs ?? [];
}

/**
 * The combined commit status, which is a *separate* system from check runs.
 *
 * Older integrations (and some deploy providers) report through the statuses
 * API rather than checks. Reading only one of the two is how a red build gets
 * merged, so the merge guard consults both.
 */
export async function getCombinedStatus(
  repo: Repo,
  ref: string,
): Promise<{ state: "success" | "pending" | "failure"; total: number }> {
  const { data } = await githubRequest<{
    state: "success" | "pending" | "failure";
    total_count: number;
  }>(
    repo.installationId,
    `${repoPath(repo)}/commits/${encodeURIComponent(ref)}/status`,
  );
  return { state: data?.state ?? "pending", total: data?.total_count ?? 0 };
}
