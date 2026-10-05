/**
 * The agent workflow every site's repository runs.
 *
 * Until now the only thing that ever put an agent workflow into a repository
 * was the GitHub template a site was generated from — and most sites were not
 * generated from it. A repository connected in place got no workflow at all,
 * so a request opened an issue that nothing read until the watchdog failed it;
 * and a repository generated from an older template kept that template's own
 * copy of the prompt and model for ever.
 *
 * So the portal installs it, beside the tokens, when automated work is
 * allowed. It is a nine-line caller of the shared workflow in
 * `cjackmort/mortensenweb-agent`, identical in every repository: the prompt,
 * model and skills are decided there, once.
 *
 * `templates/client-repo/.github/workflows/claude.yml` is the same text as a
 * file a person can read. A test holds the two together.
 */

import { getFileContent, putFileContent, type Repo } from "./rest";

export const AGENT_WORKFLOW_PATH = ".github/workflows/claude.yml";

export const AGENT_CALLER_WORKFLOW = [
  "# =============================================================================",
  "# Installed by the Mortensen Web Co. portal. Edits here are overwritten.",
  "#",
  "# The portal writes this file into every site's repository when automated work",
  "# is allowed, and again from \"Install tokens and agent workflow\". It is the",
  "# same nine lines everywhere, whatever built the site — so a change to the",
  "# agent's prompt, model or skills is made once, in the shared workflow below,",
  "# and reaches every site on its next request.",
  "#",
  "# Gated on the `claude` label so a human opening an ordinary issue never starts",
  "# a billed run by accident.",
  "#",
  "# **One run per issue, and the trigger is what guarantees it.** The portal",
  "# creates the issue with three labels attached, so GitHub fires four events —",
  "# `opened`, then `labeled` once per label. Listening to `opened` and `labeled`",
  "# meant four workflow runs for one request. The concurrency group did not save",
  "# us: `cancel-in-progress: false` *queues* the duplicates rather than dropping",
  "# them, so a second full agent run started the moment the first finished.",
  "#",
  "# Listening only for the `claude` label, and only when that is the label that",
  "# was just added, fires exactly once however many other labels the portal",
  "# attaches.",
  "# =============================================================================",
  "",
  "name: Portal change request",
  "",
  "on:",
  "  issues:",
  "    types: [labeled]",
  "",
  "# Still here as a backstop, not as the deduplication. Two runs for one issue",
  "# must never both open a pull request, whatever fires them.",
  "concurrency:",
  "  group: portal-request-${{ github.event.issue.number }}",
  "  cancel-in-progress: false",
  "",
  "permissions:",
  "  contents: write",
  "  pull-requests: write",
  "  issues: write",
  "  # Required by claude-code-action, which exchanges a GitHub OIDC token for",
  "  # its own credentials. Without it every run fails on its first step.",
  "  id-token: write",
  "",
  "jobs:",
  "  implement:",
  "    # The label that was just added, not merely present. `contains(...)` is true",
  "    # on every one of the portal's labelling events; this is true on exactly one.",
  "    if: github.event.label.name == 'claude'",
  "    uses: cjackmort/mortensenweb-agent/.github/workflows/client-change.yml@main",
  "    with:",
  "      issue_number: ${{ github.event.issue.number }}",
  "      labels: ${{ join(github.event.issue.labels.*.name, ',') }}",
  "      # Node 22 builds every site we make; Astro 7 requires it, and a site with",
  "      # no build step never uses it.",
  "      node-version: \"22\"",
  "    secrets: inherit",
  "",
].join("\n");

/**
 * Marked to skip CI and Netlify: the commit changes nothing a visitor sees,
 * and on a site that deploys from its default branch it would otherwise
 * rebuild and republish production for no reason.
 */
const COMMIT_MESSAGE =
  "chore: run portal requests through the shared agent workflow [skip ci]";

export type AgentWorkflowResult = "installed" | "replaced" | "current";

/**
 * Write the caller onto the repository's default branch.
 *
 * Replaces whatever is at that path. A repository's own older copy is exactly
 * what this exists to retire, and a caller that differs from this one is a
 * prompt or model the agency did not choose for that site.
 */
export async function installAgentCaller(
  repo: Repo,
  branch: string,
): Promise<AgentWorkflowResult> {
  const existing = await getFileContent(repo, AGENT_WORKFLOW_PATH, branch);
  if (existing?.content === AGENT_CALLER_WORKFLOW) return "current";

  await putFileContent(repo, AGENT_WORKFLOW_PATH, {
    content: AGENT_CALLER_WORKFLOW,
    message: COMMIT_MESSAGE,
    branch,
    sha: existing?.sha,
  });

  return existing ? "replaced" : "installed";
}
