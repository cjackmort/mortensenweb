import { and, eq, isNull, ne } from "drizzle-orm";
import type { Database } from "@/db/client";
import { clients, repositoryConnections, sites } from "@/db/schema";
import { connectExistingRepo } from "@/db/repositories/admin/connect-repo";
import { NotFoundError, type AdminContext } from "@/db/repositories/context";
import { getSiteGitLink, isNetlifyConfigured } from "@/lib/netlify/api";
import { OperatorApiError } from "./http";
import type { ConnectRepositoryBody } from "./schemas";

/**
 * Connecting a client's existing repository to its site, for the operator API.
 *
 * Does what admin → Website → "Connect a repository" does, through the same
 * `connectExistingRepo`. It does not allow automated work on the repository or
 * install anything into it: those are separate decisions, made by the
 * conversion's steps or the admin's buttons.
 */

type PreviewUrlStyle = "pr_alias" | "deploy_preview";

/**
 * How previews of a typed Netlify site are addressed, asked of Netlify.
 *
 * `connectExistingRepo` detects this itself only when no name is typed, and
 * the admin form leaves the choice to the operator. A site Netlify builds from
 * Git needs `deploy_preview`, or the client is shown a preview address that
 * does not exist; a self-deploying one needs `pr_alias`. Left undefined when
 * Netlify cannot say, so the column's own default stands.
 */
async function previewStyleFor(netlifySiteName: string): Promise<PreviewUrlStyle | undefined> {
  if (!isNetlifyConfigured()) return undefined;
  try {
    const link = await getSiteGitLink(`${netlifySiteName}.netlify.app`);
    if (link.status === "linked") return "deploy_preview";
    if (link.status === "unlinked") return "pr_alias";
  } catch (error) {
    console.error("[operator-api] could not ask Netlify how the site is built", { netlifySiteName, error });
  }
  return undefined;
}

/** The one site this client has, or why the API will not pick for them. */
async function onlySiteOf(db: Database, clientPublicId: string): Promise<string> {
  const [client] = await db
    .select({ organizationId: clients.organizationId })
    .from(clients)
    .where(and(eq(clients.publicId, clientPublicId), isNull(clients.archivedAt)))
    .limit(1);
  // Absent and archived read the same, as everywhere else in the portal.
  if (!client) throw new NotFoundError();

  const found = await db
    .select({ publicId: sites.publicId })
    .from(sites)
    .where(and(eq(sites.organizationId, client.organizationId), ne(sites.status, "archived")));

  if (found.length === 0) {
    throw new OperatorApiError(
      409,
      "no_site",
      "This client has no site yet. Add their site on the client's page (Website → Add their site), then connect the repository.",
    );
  }
  if (found.length > 1) {
    throw new OperatorApiError(
      409,
      "ambiguous_site",
      "This client has more than one site, and the operator API will not choose between them. Connect the repository from the client's page.",
      found.map((site) => site.publicId),
    );
  }
  return found[0]!.publicId;
}

export async function connectClientRepository(
  ctx: AdminContext,
  db: Database,
  clientPublicId: string,
  body: ConnectRepositoryBody,
): Promise<Record<string, unknown>> {
  const sitePublicId = await onlySiteOf(db, clientPublicId);
  const [owner, name] = body.repo.split("/") as [string, string];

  const outcome = await connectExistingRepo(ctx, db, {
    sitePublicId,
    owner,
    name,
    netlifySiteName: body.netlifySiteName,
    previewUrlStyle: body.netlifySiteName ? await previewStyleFor(body.netlifySiteName) : undefined,
  });

  if (!outcome.ok) {
    if (outcome.reason === "site_not_found") throw new NotFoundError();
    const failure = {
      not_configured: { status: 503, code: "not_configured" },
      repo_not_found: { status: 422, code: "repo_not_found" },
      already_connected_elsewhere: { status: 409, code: "already_connected_elsewhere" },
    }[outcome.reason];
    throw new OperatorApiError(failure.status, failure.code, outcome.message);
  }

  // What is stored, not what was asked: GitHub spells the repository's name,
  // Netlify may have supplied the site, and a reconnect keeps its allowlist.
  const [stored] = await db
    .select({
      owner: repositoryConnections.owner,
      name: repositoryConnections.name,
      defaultBranch: repositoryConnections.defaultBranch,
      allowlisted: repositoryConnections.allowlisted,
      netlifySiteName: sites.netlifySiteName,
      previewUrlStyle: sites.previewUrlStyle,
    })
    .from(sites)
    .innerJoin(repositoryConnections, eq(repositoryConnections.siteId, sites.id))
    .where(eq(sites.publicId, sitePublicId))
    .limit(1);

  const warnings = stored?.netlifySiteName
    ? []
    : [
        "No Netlify site is recorded for this site, so previews cannot be shown to the client. Connect again with netlifySiteName.",
      ];

  return {
    clientId: clientPublicId,
    sitePublicId,
    repository: `${stored?.owner ?? owner}/${stored?.name ?? name}`,
    defaultBranch: outcome.defaultBranch,
    alreadyConnected: outcome.alreadyConnected,
    netlifySiteName: stored?.netlifySiteName ?? null,
    previewUrlStyle: stored?.previewUrlStyle ?? null,
    allowlisted: stored?.allowlisted ?? false,
    warnings,
  };
}
