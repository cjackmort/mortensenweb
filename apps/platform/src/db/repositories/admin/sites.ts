import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  analyticsConnections,
  auditLog,
  repositoryConnections,
  sites,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import type { AdminContext } from "../context";
import { NotFoundError } from "../context";

/**
 * Admin site management, and the analytics connection that hangs off it.
 *
 * Analytics attaches to a *site*, not to a client, because one client can have
 * more than one. `analytics_connections` holds only the Umami website id — the
 * API key is a server secret and has no column here, deliberately, so a
 * database disclosure cannot yield a working analytics credential.
 */

export type SiteStatus = "draft" | "preview" | "live" | "archived";

export interface NewSiteInput {
  organizationId: string;
  name: string;
  primaryDomain?: string;
  status?: SiteStatus;
}

/** Strip a pasted URL down to a bare hostname. */
export function normaliseDomain(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withoutScheme = trimmed.replace(/^https?:\/\//i, "");
  const host = withoutScheme.split("/")[0]?.trim().toLowerCase() ?? "";
  return host || null;
}

export async function addSite(
  ctx: AdminContext,
  db: Database,
  input: NewSiteInput,
) {
  const name = input.name.trim();
  if (name.length < 2) throw new Error("A site name is required.");

  const rows = await db
    .insert(sites)
    .values({
      publicId: newPublicId(),
      organizationId: input.organizationId,
      name,
      primaryDomain: input.primaryDomain
        ? normaliseDomain(input.primaryDomain)
        : null,
      // Defaults to `live` for an existing client site we already built: it is
      // already serving visitors, and calling it a draft would be untrue.
      status: input.status ?? "live",
    })
    .returning({ publicId: sites.publicId });

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: input.organizationId,
    action: "site.created",
    entityType: "site",
    entityId: rows[0]!.publicId,
    metadata: { name },
  });

  return rows[0]!;
}

/**
 * A Umami website id is a UUID. Validating the shape here means a mistyped or
 * half-pasted value is refused at the boundary rather than producing an
 * analytics screen that silently shows nothing.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUmamiWebsiteId(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

export type ConnectResult =
  | { ok: true; cleared: boolean }
  | { ok: false; reason: "invalid_id" | "site_not_found" };

/**
 * Attach (or detach) an Umami website id to one site.
 *
 * Upserts on the site, because `analytics_connections` is unique per site —
 * reconnecting a site that was previously connected must update the row, not
 * fail on the unique index.
 */
export async function setAnalyticsConnection(
  ctx: AdminContext,
  db: Database,
  sitePublicId: string,
  websiteIdRaw: string,
): Promise<ConnectResult> {
  const websiteId = websiteIdRaw.trim();
  if (websiteId && !isValidUmamiWebsiteId(websiteId)) {
    return { ok: false, reason: "invalid_id" };
  }

  const siteRows = await db
    .select({ id: sites.id, organizationId: sites.organizationId })
    .from(sites)
    .where(eq(sites.publicId, sitePublicId))
    .limit(1);

  const site = siteRows[0];
  if (!site) return { ok: false, reason: "site_not_found" };

  const existing = await db
    .select({ id: analyticsConnections.id })
    .from(analyticsConnections)
    .where(eq(analyticsConnections.siteId, site.id))
    .limit(1);

  const values = {
    provider: "umami",
    umamiWebsiteId: websiteId || null,
    status: websiteId ? "connected" : "disconnected",
    lastSyncedAt: null,
  };

  if (existing[0]) {
    await db
      .update(analyticsConnections)
      .set(values)
      .where(eq(analyticsConnections.id, existing[0].id));
  } else {
    await db
      .insert(analyticsConnections)
      .values({ siteId: site.id, ...values });
  }

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: site.organizationId,
    action: websiteId ? "analytics.connected" : "analytics.disconnected",
    entityType: "site",
    entityId: sitePublicId,
    // The website id is not a secret, but it is not logged here either — the
    // audit row records that a connection changed, not its contents.
  });

  return { ok: true, cleared: websiteId === "" };
}

/**
 * Sites for one organization, with everything the operator needs to see at a
 * glance: analytics, hosting, launch state, and whether automation is on.
 *
 * One query rather than three because these are always read together — the
 * client detail page shows them in a single panel, and separate round trips
 * would let them disagree with each other on screen.
 */
export async function listSitesWithAnalytics(
  _ctx: AdminContext,
  db: Database,
  organizationId: string,
) {
  return db
    .select({
      publicId: sites.publicId,
      name: sites.name,
      primaryDomain: sites.primaryDomain,
      status: sites.status,
      umamiWebsiteId: analyticsConnections.umamiWebsiteId,
      connectionStatus: analyticsConnections.status,
      netlifySiteName: sites.netlifySiteName,
      productionUrl: sites.productionUrl,
      dnsInstructionsSentAt: sites.dnsInstructionsSentAt,
      liveVerifiedAt: sites.liveVerifiedAt,
      repoOwner: repositoryConnections.owner,
      repoName: repositoryConnections.name,
      automationEnabled: repositoryConnections.allowlisted,
      repoDefaultBranch: repositoryConnections.defaultBranch,
      previewUrlStyle: sites.previewUrlStyle,
      previewMode: sites.previewMode,
    })
    .from(sites)
    .leftJoin(analyticsConnections, eq(analyticsConnections.siteId, sites.id))
    .leftJoin(repositoryConnections, eq(repositoryConnections.siteId, sites.id))
    .where(
      and(eq(sites.organizationId, organizationId)),
    )
    .orderBy(sites.createdAt);
}

/**
 * Choose how the client grid draws this site's thumbnail.
 *
 * `live` is only meaningful when the site itself names the portal in
 * `frame-ancestors`; nothing here can check that, because the refusal happens
 * in the operator's browser and is invisible to the server. The form says so
 * rather than pretending to validate it.
 */
export async function setSitePreviewMode(
  _ctx: AdminContext,
  db: Database,
  sitePublicId: string,
  mode: "screenshot" | "live",
): Promise<{ ok: boolean }> {
  const updated = await db
    .update(sites)
    .set({ previewMode: mode, updatedAt: new Date() })
    .where(eq(sites.publicId, sitePublicId))
    .returning({ id: sites.id });
  return { ok: updated.length > 0 };
}

/** Resolve a site that belongs to the given organization, or throw. */
export async function requireOrganizationSite(
  _ctx: AdminContext,
  db: Database,
  organizationId: string,
  sitePublicId: string,
): Promise<string> {
  const rows = await db
    .select({ id: sites.id })
    .from(sites)
    .where(
      and(
        eq(sites.publicId, sitePublicId),
        eq(sites.organizationId, organizationId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError();
  return row.id;
}
