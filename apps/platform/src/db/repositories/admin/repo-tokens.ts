import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, repositoryConnections, sites } from "@/db/schema";
import { provisionRepoSecrets } from "@/lib/github/secrets";
import { installAgentCaller, type AgentWorkflowResult } from "@/lib/github/agent-workflow";
import { installDeployCaller } from "@/lib/github/deploy-workflow";
import { setRepoVariable, type Repo } from "@/lib/github/rest";

/**
 * Installing the portal's tokens into a site's repository.
 *
 * The portal's environment is the one place CLAUDE_CODE_OAUTH_TOKEN and
 * NETLIFY_AUTH_TOKEN are kept. Scaffolding has always sealed them into the
 * repositories it creates; a repository connected in place got nothing, so its
 * agent and deploy workflows failed until someone pasted both tokens in by
 * hand. This does for a connected repository what scaffolding does for a new
 * one, and running it again after a token is replaced in the portal's
 * environment is how that replacement reaches the repository.
 *
 * Values never leave this process unsealed and are never returned or logged —
 * only the names that landed. GitHub has no API to read a secret back.
 */

export type TokenInstallOutcome =
  | {
      ok: true;
      repository: string;
      written: string[];
      missing: string[];
      failed: { name: string; reason: string }[];
    }
  | { ok: false; reason: "site_not_found" | "no_repository" | "not_configured" };

type SiteRepo =
  | {
      ok: true;
      organizationId: string;
      target: Repo;
      defaultBranch: string;
      repository: string;
    }
  | { ok: false; reason: "site_not_found" | "no_repository" | "not_configured" };

/** The repository a site is connected to, and the installation to write with. */
async function resolveSiteRepo(db: Database, sitePublicId: string): Promise<SiteRepo> {
  const siteRows = await db
    .select({ id: sites.id, organizationId: sites.organizationId })
    .from(sites)
    .where(eq(sites.publicId, sitePublicId))
    .limit(1);

  const site = siteRows[0];
  if (!site) return { ok: false, reason: "site_not_found" };

  const repoRows = await db
    .select({
      owner: repositoryConnections.owner,
      name: repositoryConnections.name,
      installationId: repositoryConnections.installationId,
      defaultBranch: repositoryConnections.defaultBranch,
    })
    .from(repositoryConnections)
    .where(eq(repositoryConnections.siteId, site.id))
    .limit(1);

  const repo = repoRows[0];
  if (!repo) return { ok: false, reason: "no_repository" };

  // The connection's own installation when it recorded one; otherwise the
  // portal's, which is what connecting falls back to as well.
  const installationId = repo.installationId ?? process.env.GITHUB_INSTALLATION_ID;
  if (!installationId) return { ok: false, reason: "not_configured" };

  return {
    ok: true,
    organizationId: site.organizationId,
    target: { installationId, owner: repo.owner, name: repo.name },
    defaultBranch: repo.defaultBranch ?? "main",
    repository: `${repo.owner}/${repo.name}`,
  };
}

export async function installRepoTokens(
  db: Database,
  actorUserId: string,
  sitePublicId: string,
): Promise<TokenInstallOutcome> {
  const resolved = await resolveSiteRepo(db, sitePublicId);
  if (!resolved.ok) return resolved;

  const result = await provisionRepoSecrets(resolved.target);
  const { repository } = resolved;

  await db.insert(auditLog).values({
    actorUserId,
    organizationId: resolved.organizationId,
    action: "repository.tokens_installed",
    entityType: "site",
    entityId: sitePublicId,
    metadata: {
      repository,
      written: result.written,
      missing: result.missing,
      failed: result.failed.map((f) => f.name),
    },
  });

  return { ok: true, repository, ...result };
}

export type WorkflowInstallOutcome =
  | { ok: true; repository: string; result: AgentWorkflowResult }
  | { ok: false; reason: "site_not_found" | "no_repository" | "not_configured" };

/**
 * Put the shared agent workflow's caller into a site's repository.
 *
 * Run beside the tokens, for the same reason: a repository allowed to receive
 * automated work needs both, and one connected in place had neither. Running
 * it on a repository that already has the caller writes nothing.
 */
export async function installAgentWorkflow(
  db: Database,
  actorUserId: string,
  sitePublicId: string,
): Promise<WorkflowInstallOutcome> {
  const resolved = await resolveSiteRepo(db, sitePublicId);
  if (!resolved.ok) return resolved;

  const result = await installAgentCaller(resolved.target, resolved.defaultBranch);

  await db.insert(auditLog).values({
    actorUserId,
    organizationId: resolved.organizationId,
    action: "repository.agent_workflow_installed",
    entityType: "site",
    entityId: sitePublicId,
    metadata: { repository: resolved.repository, result },
  });

  return { ok: true, repository: resolved.repository, result };
}

/**
 * Put the shared deploy workflow's caller into a scaffolded site's repository.
 *
 * Not offered for a repository connected in place — see
 * `lib/github/deploy-workflow.ts` for why that would deploy twice. This
 * installs unconditionally; the caller decides, and the conversion's
 * `deploy_workflow` and `netlify_site_variable` steps do.
 */
export async function installDeployWorkflow(
  db: Database,
  actorUserId: string,
  sitePublicId: string,
): Promise<WorkflowInstallOutcome> {
  const resolved = await resolveSiteRepo(db, sitePublicId);
  if (!resolved.ok) return resolved;

  const result = await installDeployCaller(resolved.target, resolved.defaultBranch);

  await db.insert(auditLog).values({
    actorUserId,
    organizationId: resolved.organizationId,
    action: "repository.deploy_workflow_installed",
    entityType: "site",
    entityId: sitePublicId,
    metadata: { repository: resolved.repository, result },
  });

  return { ok: true, repository: resolved.repository, result };
}

export type SiteVariableOutcome =
  | { ok: true; repository: string; netlifySiteId: string }
  | { ok: false; reason: "site_not_found" | "no_repository" | "not_configured" | "no_netlify_site" };

/**
 * Write the site's Netlify id into its repository as `NETLIFY_SITE_ID`.
 *
 * The join between the two systems that `scaffoldSite` makes when it creates
 * both; run again here so a repository whose variable was lost, or set before
 * its Netlify site was recreated, deploys to the site the portal knows about.
 */
export async function installNetlifySiteVariable(
  db: Database,
  actorUserId: string,
  sitePublicId: string,
): Promise<SiteVariableOutcome> {
  const resolved = await resolveSiteRepo(db, sitePublicId);
  if (!resolved.ok) return resolved;

  const [site] = await db
    .select({ netlifySiteId: sites.netlifySiteId })
    .from(sites)
    .where(eq(sites.publicId, sitePublicId))
    .limit(1);
  if (!site?.netlifySiteId) return { ok: false, reason: "no_netlify_site" };

  await setRepoVariable(resolved.target, "NETLIFY_SITE_ID", site.netlifySiteId);

  await db.insert(auditLog).values({
    actorUserId,
    organizationId: resolved.organizationId,
    action: "repository.netlify_site_variable_set",
    entityType: "site",
    entityId: sitePublicId,
    metadata: { repository: resolved.repository, netlifySiteId: site.netlifySiteId },
  });

  return { ok: true, repository: resolved.repository, netlifySiteId: site.netlifySiteId };
}

export function describeWorkflowInstall(outcome: WorkflowInstallOutcome): {
  ok: boolean;
  message: string;
} {
  if (!outcome.ok) {
    const messages = {
      no_repository: "Connect a repository first. There is nowhere to install the agent workflow.",
      not_configured: "Set GITHUB_INSTALLATION_ID in the portal's environment first.",
      site_not_found: "No such site.",
    } as const;
    return { ok: false, message: messages[outcome.reason] };
  }

  const said = {
    installed: `Installed the agent workflow in ${outcome.repository}.`,
    replaced: `Replaced ${outcome.repository}'s own agent workflow with the shared one.`,
    current: `${outcome.repository} already runs the shared agent workflow.`,
  } as const;
  return { ok: true, message: said[outcome.result] };
}

/** What to tell the operator. Not ok whenever any token did not land. */
export function describeTokenInstall(outcome: TokenInstallOutcome): {
  ok: boolean;
  message: string;
} {
  if (!outcome.ok) {
    const messages = {
      no_repository: "Connect a repository first. There is nowhere to install the tokens.",
      not_configured: "Set GITHUB_INSTALLATION_ID in the portal's environment first.",
      site_not_found: "No such site.",
    } as const;
    return { ok: false, message: messages[outcome.reason] };
  }

  const problems = [
    ...outcome.missing.map(
      (name) =>
        `${name} is not set in the portal's environment (Netlify → the portal's project → Environment variables)`,
    ),
    ...outcome.failed.map((f) => `Could not write ${f.name}: ${f.reason}`),
  ];

  if (problems.length > 0) {
    const landed = outcome.written.length
      ? ` Installed ${outcome.written.join(" and ")}.`
      : "";
    return {
      ok: false,
      message: `${problems.join(". ")}.${landed} Until every token is in ${outcome.repository}, its agent and deploy workflows fail.`,
    };
  }

  return {
    ok: true,
    message: `Installed ${outcome.written.join(" and ")} in ${outcome.repository}.`,
  };
}
