import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  clients,
  conceptJobs,
  conceptRepositories,
  prospectContacts,
  prospectConversions,
  prospects,
  repositoryConnections,
  sites,
} from "@/db/schema";
import { getFileContent, type Repo } from "@/lib/github/rest";
import { isGithubConfigured } from "@/lib/github/app";
import { parseSiteJson, SITE_JSON_PATH, type SiteJson } from "@/lib/site-json/read";
import { NotFoundError } from "../context";

/**
 * What a conversion run knows about the potential client, read from the
 * database rather than carried between runs. Every run starts here, so a step
 * that was finished last time and is not repeated still leaves the facts it
 * established — the client, the site — for the steps after it.
 */

export interface ConversionProspect {
  id: string;
  publicId: string;
  businessName: string;
  industry: string | null;
  status: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}

export interface ConversionSite {
  siteId: string;
  sitePublicId: string;
  organizationId: string;
  status: string;
  primaryDomain: string | null;
  netlifySiteId: string | null;
  netlifySiteName: string | null;
  formsConnectedAt: Date | null;
  /** Null when the site has no repository connection the portal can write with. */
  repo: { target: Repo; defaultBranch: string; repository: string } | null;
}

export interface ConversionClient {
  clientId: string;
  clientPublicId: string;
  organizationId: string;
  primaryContactName: string | null;
  primaryContactEmail: string | null;
  bookingEnabled: boolean;
  shopEnabled: boolean;
}

export async function loadProspect(db: Database, publicId: string): Promise<ConversionProspect> {
  const [row] = await db
    .select({
      id: prospects.id,
      publicId: prospects.publicId,
      businessName: prospects.businessName,
      industry: prospects.industry,
      status: prospects.status,
    })
    .from(prospects)
    .where(and(eq(prospects.publicId, publicId), isNull(prospects.archivedAt)))
    .limit(1);
  if (!row) throw new NotFoundError("Potential client not found");

  // The first contact is the one intake wrote and the edit form shows.
  const [contact] = await db
    .select({
      name: prospectContacts.name,
      email: prospectContacts.email,
      phone: prospectContacts.phone,
    })
    .from(prospectContacts)
    .where(eq(prospectContacts.prospectId, row.id))
    .orderBy(asc(prospectContacts.createdAt))
    .limit(1);

  return {
    ...row,
    contactName: contact?.name ?? null,
    contactEmail: contact?.email ?? null,
    contactPhone: contact?.phone ?? null,
  };
}

/** The client this prospect became, if it has. */
export async function loadClient(
  db: Database,
  prospectId: string,
): Promise<(ConversionClient & { siteId: string | null }) | null> {
  const [row] = await db
    .select({
      clientId: clients.id,
      clientPublicId: clients.publicId,
      organizationId: clients.organizationId,
      primaryContactName: clients.primaryContactName,
      primaryContactEmail: clients.primaryContactEmail,
      bookingEnabled: clients.bookingEnabled,
      shopEnabled: clients.shopEnabled,
      siteId: prospectConversions.siteId,
    })
    .from(prospectConversions)
    .innerJoin(clients, eq(clients.id, prospectConversions.clientId))
    .where(eq(prospectConversions.prospectId, prospectId))
    .limit(1);
  return row ?? null;
}

/**
 * The site to carry over: the one the conversion recorded, or else the latest
 * concept's — found through its repository, which is the one link a concept
 * always has once scaffolding got past creating it.
 */
export async function loadSite(
  db: Database,
  prospectId: string,
  recordedSiteId: string | null,
): Promise<ConversionSite | null> {
  let siteId = recordedSiteId;

  if (!siteId) {
    const [concept] = await db
      .select({ siteId: repositoryConnections.siteId })
      .from(conceptJobs)
      .innerJoin(conceptRepositories, eq(conceptRepositories.conceptJobId, conceptJobs.id))
      .innerJoin(
        repositoryConnections,
        and(
          eq(repositoryConnections.owner, conceptRepositories.owner),
          eq(repositoryConnections.name, conceptRepositories.name),
        ),
      )
      .where(eq(conceptJobs.prospectId, prospectId))
      .orderBy(desc(conceptJobs.createdAt))
      .limit(1);
    siteId = concept?.siteId ?? null;
  }
  if (!siteId) return null;

  const [site] = await db
    .select({
      siteId: sites.id,
      sitePublicId: sites.publicId,
      organizationId: sites.organizationId,
      status: sites.status,
      primaryDomain: sites.primaryDomain,
      netlifySiteId: sites.netlifySiteId,
      netlifySiteName: sites.netlifySiteName,
      formsConnectedAt: sites.formsConnectedAt,
      owner: repositoryConnections.owner,
      name: repositoryConnections.name,
      installationId: repositoryConnections.installationId,
      defaultBranch: repositoryConnections.defaultBranch,
    })
    .from(sites)
    .leftJoin(repositoryConnections, eq(repositoryConnections.siteId, sites.id))
    .where(eq(sites.id, siteId))
    .limit(1);
  if (!site) return null;

  const installationId = site.installationId ?? process.env.GITHUB_INSTALLATION_ID;
  const repo =
    site.owner && site.name && installationId
      ? {
          target: { installationId, owner: site.owner, name: site.name },
          defaultBranch: site.defaultBranch ?? "main",
          repository: `${site.owner}/${site.name}`,
        }
      : null;

  return {
    siteId: site.siteId,
    sitePublicId: site.sitePublicId,
    organizationId: site.organizationId,
    status: site.status,
    primaryDomain: site.primaryDomain,
    netlifySiteId: site.netlifySiteId,
    netlifySiteName: site.netlifySiteName,
    formsConnectedAt: site.formsConnectedAt,
    repo,
  };
}

export type SiteJsonLoad =
  | { ok: true; site: SiteJson; raw: Record<string, unknown>; source: string; sha: string }
  | { ok: false; reason: "no_repository" | "absent" | "invalid"; message: string };

/** `src/content/site.json` from the default branch, read once per run. */
export async function loadSiteJson(site: ConversionSite | null): Promise<SiteJsonLoad> {
  if (!site?.repo || !isGithubConfigured()) {
    return { ok: false, reason: "no_repository", message: "There is no repository to read site.json from." };
  }

  const file = await getFileContent(site.repo.target, SITE_JSON_PATH, site.repo.defaultBranch);
  if (!file) {
    return {
      ok: false,
      reason: "absent",
      message: `${site.repo.repository} has no ${SITE_JSON_PATH}.`,
    };
  }

  const parsed = parseSiteJson(file.content);
  if (!parsed.ok) return { ok: false, reason: "invalid", message: parsed.message };
  return { ok: true, site: parsed.site, raw: parsed.raw, source: file.content, sha: file.sha };
}
