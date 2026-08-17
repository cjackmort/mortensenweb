import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, repositoryConnections, sites } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { isGithubConfigured } from "@/lib/github/app";
import { getRepo } from "@/lib/github/rest";
import { findSiteByRepo, isNetlifyConfigured } from "@/lib/netlify/api";
import type { AdminContext } from "../context";

/**
 * Connecting a repository that already exists.
 *
 * Scaffolding creates a repository and connects it in one motion, which covers
 * every client built from scratch. It does not cover the ones that matter
 * commercially: a business already on our books, whose site predates the
 * portal. Until now there was no path at all for those — the schema had a
 * `connected_existing` mode and nothing that could produce one.
 *
 * ## Why the allowlist is not set here
 *
 * Connecting records that a repository exists and belongs to a site.
 * Allowlisting authorises an agent to write to it. Those are different
 * decisions, and the second deserves its own deliberate act — which is why
 * `allowlisted` starts false and `setAllowlisted` is a separate call the
 * operator makes knowingly.
 *
 * ## Identity is the node id
 *
 * `repo_node_id` is what everything downstream matches on, because names can be
 * changed by anyone with push access and node ids cannot. Fetching it here, at
 * connect time, means a repository renamed later still resolves — and a
 * different repository given the old name does not quietly inherit its
 * permissions.
 */

export type ConnectOutcome =
  | {
      ok: true;
      repoNodeId: string;
      defaultBranch: string;
      alreadyConnected: boolean;
      /** Set when the Netlify site was found rather than typed. */
      detectedSiteName: string | null;
    }
  | {
      ok: false;
      reason:
        | "not_configured"
        | "site_not_found"
        | "repo_not_found"
        | "already_connected_elsewhere";
      message: string;
    };

export interface ConnectInput {
  sitePublicId: string;
  owner: string;
  name: string;
  /**
   * How this site's previews are addressed. A repository Netlify already
   * builds from Git uses `deploy_preview`; one deploying itself from our
   * template workflow uses `pr_alias`.
   */
  previewUrlStyle?: "pr_alias" | "deploy_preview";
  /**
   * The Netlify site's name, e.g. `scott-mortensen-fine-arts`.
   *
   * Only scaffolding used to record this, so a repository connected in place
   * had none — and without it there is no way to build a preview URL at all.
   * The agent would work, the pull request would open, Netlify would build a
   * preview, and the client would be shown nothing.
   */
  netlifySiteName?: string;
}

export async function connectExistingRepo(
  ctx: AdminContext,
  db: Database,
  input: ConnectInput,
): Promise<ConnectOutcome> {
  if (!isGithubConfigured()) {
    return {
      ok: false,
      reason: "not_configured",
      message: "The GitHub App is not configured in this environment.",
    };
  }

  const installationId = process.env.GITHUB_INSTALLATION_ID;
  if (!installationId) {
    return {
      ok: false,
      reason: "not_configured",
      message: "Set GITHUB_INSTALLATION_ID before connecting a repository.",
    };
  }

  const siteRows = await db
    .select({ id: sites.id, organizationId: sites.organizationId })
    .from(sites)
    .where(eq(sites.publicId, input.sitePublicId))
    .limit(1);

  const site = siteRows[0];
  if (!site) {
    return { ok: false, reason: "site_not_found", message: "No such site." };
  }

  // Reading it through the App is the check that matters. It proves the
  // repository exists, that the installation can see it, and — since the token
  // is scoped to the installation — that it is one we are entitled to touch.
  // Trusting a typed name would let an operator connect a repository the App
  // cannot reach, and the failure would surface much later as a dispatch that
  // cannot open an issue.
  // A 404 comes back as null rather than as a throw, and the two are not the
  // same: null means "the App looked and it is not there", which is exactly the
  // case an operator needs told about. Anything else genuinely thrown is a
  // transport failure and belongs to the caller's guard.
  const repo = await getRepo(installationId, input.owner, input.name);
  if (!repo) {
    return {
      ok: false,
      reason: "repo_not_found",
      message: `Could not read ${input.owner}/${input.name}. Check the name, and that the GitHub App is installed on it — "All repositories" covers repos created later.`,
    };
  }

  const existing = await db
    .select({ id: repositoryConnections.id, siteId: repositoryConnections.siteId })
    .from(repositoryConnections)
    .where(eq(repositoryConnections.repoNodeId, repo.node_id))
    .limit(1);

  const prior = existing[0];
  if (prior && prior.siteId !== site.id) {
    // One repository, one site. Allowing two would mean a change request for
    // either could open a pull request against the same code, with each
    // client's approval merging the other's work.
    return {
      ok: false,
      reason: "already_connected_elsewhere",
      message: "That repository is already connected to a different site.",
    };
  }

  if (prior) {
    await db
      .update(repositoryConnections)
      .set({
        owner: input.owner,
        name: repo.name,
        defaultBranch: repo.default_branch,
        installationId,
      })
      .where(eq(repositoryConnections.id, prior.id));
  } else {
    await db.insert(repositoryConnections).values({
      publicId: newPublicId(),
      siteId: site.id,
      provider: "github",
      owner: input.owner,
      name: repo.name,
      repoNodeId: repo.node_id,
      defaultBranch: repo.default_branch,
      installationId,
      connectionMode: "connected_existing",
      // Deliberately false. See the note at the top of this file.
      allowlisted: false,
    });
  }

  // Ask Netlify rather than the operator.
  //
  // Both of these fields fail silently when wrong — no preview URL is built,
  // or one is built that 404s — and Netlify already knows both answers. A site
  // whose build settings name this repository is, by definition, building its
  // pull requests, which is what makes previews `deploy-preview-<n>--` rather
  // than an alias the repository publishes for itself.
  //
  // A value the operator supplied still wins: detection is a convenience, and
  // overriding it must remain possible for the case it gets something wrong.
  let detectedSiteName: string | undefined;
  let detectedStyle: "pr_alias" | "deploy_preview" | undefined;

  if (!input.netlifySiteName && isNetlifyConfigured()) {
    try {
      const linked = await findSiteByRepo(`${input.owner}/${repo.name}`);
      if (linked) {
        detectedSiteName = linked.name;
        detectedStyle = "deploy_preview";
      }
    } catch (error) {
      // Detection failing is not a reason to refuse the connection — it just
      // means the operator fills the field in by hand.
      console.error("[connect] could not look up the Netlify site", error);
    }
  }

  const siteName = input.netlifySiteName ?? detectedSiteName;
  const style = input.previewUrlStyle ?? detectedStyle;

  if (style || siteName) {
    await db
      .update(sites)
      .set({
        ...(style ? { previewUrlStyle: style } : {}),
        ...(siteName ? { netlifySiteName: siteName.trim() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(sites.id, site.id));
  }

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: site.organizationId,
    action: prior ? "repository.reconnected" : "repository.connected",
    entityType: "site",
    entityId: input.sitePublicId,
    metadata: {
      repository: `${input.owner}/${repo.name}`,
      repoNodeId: repo.node_id,
      previewUrlStyle: style ?? "pr_alias",
      netlifySiteName: siteName ?? null,
      netlifySiteDetected: Boolean(detectedSiteName),
      mode: "connected_existing",
    },
  });

  return {
    ok: true,
    repoNodeId: repo.node_id,
    defaultBranch: repo.default_branch,
    alreadyConnected: Boolean(prior),
    detectedSiteName: detectedSiteName ?? null,
  };
}
