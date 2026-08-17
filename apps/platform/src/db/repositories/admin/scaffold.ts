import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  auditLog,
  repositoryConnections,
  sites,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { isGithubConfigured } from "@/lib/github/app";
import {
  createRepoFromTemplate,
  setRepoVariable,
  type Repo,
} from "@/lib/github/rest";
import {
  describeProvisioning,
  provisionRepoSecrets,
} from "@/lib/github/secrets";
import {
  createSite as createNetlifySite,
  isNetlifyConfigured,
  toSiteName,
} from "@/lib/netlify/api";

/**
 * Standing up somewhere for a website to live.
 *
 * Three external objects have to exist, in this order, before an agent can be
 * asked to build anything:
 *
 *   1. a GitHub repository, generated from the template
 *   2. a Netlify site, which gives us a hostname and a deploy target
 *   3. an Actions **variable** in the repository holding the Netlify site id
 *
 * Step 3 is what joins the first two. The repository's own workflow reads
 * `vars.NETLIFY_SITE_ID` and deploys itself; nothing in Netlify knows about
 * GitHub, and nothing in GitHub holds a Netlify credential beyond the
 * account-level token. See D2 in `docs/stage-3-automation-plan.md` for why the
 * more obvious "link the repo to Netlify" route is not taken.
 *
 * ## Partial failure
 *
 * These are three calls to two providers with no transaction across them, so
 * the interesting question is what happens when the second fails. The answer
 * here is: **record what succeeded and report precisely what did not.** The
 * repository row is written as soon as the repository exists, so a failure at
 * the Netlify step leaves a real repository that the portal knows about and can
 * be finished by hand — rather than an orphan that nothing references and that
 * blocks the name on a retry.
 */

export interface ScaffoldInput {
  /** Used to derive both repository and Netlify site names. */
  businessName: string;
  organizationId: string;
  /** Prospect concepts are private and stay private. */
  isPrivate: boolean;
  /** Prefix distinguishing a prospect concept from a client site. */
  namePrefix?: string;
  description?: string;
  /**
   * Generate from one of our own sites instead of the generic starter, as
   * `owner/name`. The repository must be marked as a template on GitHub —
   * `/generate` refuses anything else, with a 404 that reads like the repo
   * does not exist.
   */
  templateRepo?: string;
}

export type ScaffoldOutcome =
  | {
      ok: true;
      siteId: string;
      sitePublicId: string;
      repo: { owner: string; name: string; htmlUrl: string };
      netlify: { siteId: string; siteName: string; url: string } | null;
      /** Set when the repository exists but hosting could not be finished. */
      warning?: string;
    }
  | {
      ok: false;
      reason:
        | "github_not_configured"
        | "template_missing"
        | "repo_failed";
      message: string;
    };

/** Slugify to the intersection of what GitHub and DNS both accept. */
export function toRepoName(businessName: string, suffix: string): string {
  const slug = businessName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${(slug || "site").slice(0, 60)}-${suffix.toLowerCase().slice(0, 6)}`;
}

export async function scaffoldSite(
  db: Database,
  actorUserId: string,
  input: ScaffoldInput,
): Promise<ScaffoldOutcome> {
  if (!isGithubConfigured()) {
    return {
      ok: false,
      reason: "github_not_configured",
      message: "The GitHub App is not configured in this environment.",
    };
  }

  const owner = process.env.GITHUB_REPO_OWNER;
  const installationId = process.env.GITHUB_INSTALLATION_ID;

  // A reference site wins over the configured default. Split rather than
  // parsed loosely: a value without a slash is a configuration mistake, and
  // silently treating it as a bare repo name under the default owner would
  // generate from the wrong source without saying so.
  const reference = input.templateRepo?.includes("/")
    ? input.templateRepo.split("/")
    : null;

  const templateOwner = reference?.[0] ?? process.env.GITHUB_TEMPLATE_OWNER ?? owner;
  const templateName = reference?.[1] ?? process.env.GITHUB_TEMPLATE_REPO;

  if (!owner || !templateName || !installationId) {
    return {
      ok: false,
      reason: "template_missing",
      message:
        "Set GITHUB_REPO_OWNER, GITHUB_TEMPLATE_REPO and GITHUB_INSTALLATION_ID before scaffolding.",
    };
  }

  // One suffix for both names, so a repository and its Netlify site are
  // obviously the same thing when you are looking at two dashboards.
  const suffix = newPublicId().slice(0, 6);
  const prefix = input.namePrefix ? `${input.namePrefix}-` : "";
  const repoName = `${prefix}${toRepoName(input.businessName, suffix)}`;

  let repo;
  try {
    repo = await createRepoFromTemplate(
      installationId,
      { owner: templateOwner!, name: templateName },
      {
        owner,
        name: repoName,
        description: input.description,
        private: input.isPrivate,
      },
    );
  } catch (error) {
    return {
      ok: false,
      reason: "repo_failed",
      message:
        error instanceof Error
          ? `Could not create the repository: ${error.message}`
          : "Could not create the repository.",
    };
  }

  // Written now, before Netlify is attempted. If hosting fails, the repository
  // is still recorded and recoverable rather than orphaned.
  const sitePublicId = newPublicId();
  const inserted = await db
    .insert(sites)
    .values({
      publicId: sitePublicId,
      organizationId: input.organizationId,
      name: input.businessName,
      status: "draft",
    })
    .returning({ id: sites.id });

  const siteId = inserted[0]!.id;

  await db.insert(repositoryConnections).values({
    publicId: newPublicId(),
    siteId,
    provider: "github",
    owner,
    name: repo.name,
    repoNodeId: repo.node_id,
    installationId,
    defaultBranch: repo.default_branch,
    connectionMode: "managed",
    // Allowlisting is a separate, deliberate act. A repository that has just
    // been created has never been looked at, and automation writing to it
    // unattended from the moment it exists removes the one checkpoint between
    // "scaffolded" and "an agent has push access".
    allowlisted: false,
    verifiedAt: new Date(),
  });

  const target: Repo = { installationId, owner, name: repo.name };

  let netlify: { siteId: string; siteName: string; url: string } | null = null;
  const warnings: string[] = [];

  // Seal the credentials the repository's own workflows need. Done before
  // Netlify, because a repository that can deploy but cannot run the agent is
  // less useful than one that can run the agent but not yet deploy — and if
  // only one of the two is going to succeed, this is the one worth having.
  const secrets = await provisionRepoSecrets(target);
  const secretsNote = describeProvisioning(secrets);
  if (secretsNote) warnings.push(secretsNote);

  if (isNetlifyConfigured()) {
    try {
      const siteName = toSiteName(input.businessName, suffix);
      const created = await createNetlifySite({ name: siteName });

      netlify = {
        siteId: created.id,
        siteName: created.name,
        url: created.ssl_url || created.url,
      };

      await db
        .update(sites)
        .set({
          netlifySiteId: created.id,
          netlifySiteName: created.name,
          updatedAt: new Date(),
        })
        .where(eq(sites.id, siteId));

      // The join between the two systems. Plaintext variable, not a secret —
      // a Netlify site id appears in deploy URLs and build logs.
      await setRepoVariable(target, "NETLIFY_SITE_ID", created.id);
    } catch (error) {
      warnings.push(
        error instanceof Error
          ? `Netlify setup failed: ${error.message}`
          : "Netlify setup failed.",
      );
    }
  } else {
    warnings.push(
      "Netlify is not configured, so no hosting was set up.",
    );
  }

  // Collapsed once, here, so callers deal with a single optional message
  // rather than reasoning about which of three things went wrong.
  const warning = warnings.length > 0 ? warnings.join(" ") : undefined;

  await db.insert(auditLog).values({
    actorUserId,
    organizationId: input.organizationId,
    action: "site.scaffolded",
    entityType: "site",
    entityId: sitePublicId,
    metadata: {
      repository: `${owner}/${repo.name}`,
      private: input.isPrivate,
      netlifySiteId: netlify?.siteId ?? null,
      secretsWritten: secrets.written,
      secretsMissing: secrets.missing,
      ...(warning ? { warning } : {}),
    },
  });

  return {
    ok: true,
    siteId,
    sitePublicId,
    repo: { owner, name: repo.name, htmlUrl: repo.html_url },
    netlify,
    warning,
  };
}

/**
 * Turn on automation for a repository.
 *
 * Deliberately its own function and its own operator action. `allowlisted` is
 * checked at all three write paths — dispatch, webhook, merge — and this is the
 * only thing that sets it, so an operator turning it on is doing exactly one
 * legible thing: authorising an agent to open pull requests against this
 * repository.
 */
export async function allowlistRepository(
  db: Database,
  actorUserId: string,
  sitePublicId: string,
  allowed: boolean,
): Promise<boolean> {
  const rows = await db
    .select({ id: sites.id, organizationId: sites.organizationId })
    .from(sites)
    .where(eq(sites.publicId, sitePublicId))
    .limit(1);

  const site = rows[0];
  if (!site) return false;

  const updated = await db
    .update(repositoryConnections)
    .set({ allowlisted: allowed })
    .where(eq(repositoryConnections.siteId, site.id))
    .returning({ id: repositoryConnections.id });

  if (updated.length === 0) return false;

  await db.insert(auditLog).values({
    actorUserId,
    organizationId: site.organizationId,
    action: allowed ? "repository.allowlisted" : "repository.delisted",
    entityType: "site",
    entityId: sitePublicId,
  });

  return true;
}
