/**
 * The deploy workflow a scaffolded site's repository runs.
 *
 * A scaffolded repository publishes itself: its workflow reads
 * `vars.NETLIFY_SITE_ID` and deploys with the CLI (D2 in
 * `docs/stage-3-automation-plan.md`). Generating it from a template gave it
 * whatever deploy workflow that template carried — often a full older copy, or
 * none — so the portal writes the same caller of the shared workflow in
 * `cjackmort/mortensenweb-agent` that `templates/client-repo` ships.
 *
 * **Only for repositories the portal scaffolded.** A repository connected in
 * place usually deploys through Netlify's Git integration, and adding this
 * caller there would publish every change twice, racing each other. Converting
 * a potential client is the one caller today: its concept repository was
 * scaffolded by `scaffoldSite`. A conversion can also reach a repository
 * connected in place, so it asks Netlify whether the site is linked to Git
 * first (`deployPath` in `db/repositories/admin/conversion-steps.ts`) and skips
 * this when it is.
 *
 * `templates/client-repo/.github/workflows/deploy.yml` is the same text as a
 * file a person can read. A test holds the two together.
 */

import { installWorkflowFile, type AgentWorkflowResult } from "./agent-workflow";
import type { Repo } from "./rest";

export const DEPLOY_WORKFLOW_PATH = ".github/workflows/deploy.yml";

export const DEPLOY_CALLER_WORKFLOW = [
  "# =============================================================================",
  "# TEMPLATE — copied into every client repository at scaffold time.",
  "#",
  "# A caller. Build, verification, screenshots and the two deploy paths (preview",
  "# on a pull request, production on main) live in the agency repository's",
  "# reusable workflow. See that file for what each path means.",
  "#",
  "# One deploy per ref: two builds racing to publish the same alias would let the",
  "# loser overwrite the winner, and the client would see the older version.",
  "# =============================================================================",
  "",
  "name: Deploy",
  "",
  "on:",
  "  push:",
  "    branches: [main]",
  "  pull_request:",
  "    types: [opened, synchronize, reopened]",
  "",
  "concurrency:",
  "  group: deploy-${{ github.ref }}",
  "  cancel-in-progress: true",
  "",
  "permissions:",
  "  contents: read",
  "  statuses: write",
  "  pull-requests: write",
  "",
  "jobs:",
  "  deploy:",
  "    uses: cjackmort/mortensenweb-agent/.github/workflows/client-deploy.yml@main",
  "    secrets: inherit",
  "",
].join("\n");

/**
 * Marked to skip CI: writing the deploy workflow changes nothing a visitor
 * sees, and the run it would trigger is the very workflow being installed.
 */
const COMMIT_MESSAGE = "chore: deploy through the shared deploy workflow [skip ci]";

export async function installDeployCaller(
  repo: Repo,
  branch: string,
): Promise<AgentWorkflowResult> {
  return installWorkflowFile(repo, branch, {
    path: DEPLOY_WORKFLOW_PATH,
    content: DEPLOY_CALLER_WORKFLOW,
    message: COMMIT_MESSAGE,
  });
}
