import { and, desc, eq, isNull, like, or } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  analyticsConnections,
  auditLog,
  CAMPAIGN_PLACEMENTS,
  campaigns,
  sites,
  type CampaignPlacement,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import {
  destinationFromInput,
  destinationUrl,
  newCampaignCode,
  PLACEMENT_LABELS,
  printedLink,
  shortLink,
  siteOrigin,
  utmCampaignSlug,
} from "@/lib/campaigns/links";
import { assertMutable, NotFoundError, type TenantContext } from "../context";
import { scanCountsByCampaign } from "./campaign-stats";

/**
 * A client's campaigns, tenant-scoped.
 *
 * Every query filters on `ctx.organizationId`; a public id from another
 * tenant is `NotFoundError`, indistinguishable from one that never existed.
 * Scans are written by the redirect, which has no session — see
 * `admin/campaign-redirect.ts`.
 */

export function isPlacement(value: unknown): value is CampaignPlacement {
  return typeof value === "string" && (CAMPAIGN_PLACEMENTS as readonly string[]).includes(value);
}

export type CampaignResult = { ok: true; publicId: string } | { ok: false; message: string };

const MAX_NAME_LENGTH = 80;
/** A fresh six-character code colliding once is unlikely; five times means something else is wrong. */
const CODE_ATTEMPTS = 5;

export interface CampaignSiteOption {
  publicId: string;
  name: string;
  /** Null until the site has an address a code can point at. */
  origin: string | null;
}

export async function listCampaignSites(db: Database, ctx: TenantContext): Promise<CampaignSiteOption[]> {
  const rows = await db
    .select({
      publicId: sites.publicId,
      name: sites.name,
      productionUrl: sites.productionUrl,
      primaryDomain: sites.primaryDomain,
    })
    .from(sites)
    .where(and(eq(sites.organizationId, ctx.organizationId), isNull(sites.archivedAt)))
    .orderBy(sites.name);
  return rows.map((row) => ({ publicId: row.publicId, name: row.name, origin: siteOrigin(row) }));
}

function cleanName(raw: string): string | null {
  const name = raw.replace(/\s+/g, " ").trim();
  return name.length > 0 && name.length <= MAX_NAME_LENGTH ? name : null;
}

const NAME_MESSAGE = `Give the campaign a name of up to ${MAX_NAME_LENGTH} characters, such as "Spring door hangers".`;

/** `yard-signs`, then `yard-signs-2`: one analytics name per campaign, forever. */
async function freeUtmCampaign(db: Database, ctx: TenantContext, name: string): Promise<string> {
  const base = utmCampaignSlug(name);
  const taken = await db
    .select({ utm: campaigns.utmCampaign })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.organizationId, ctx.organizationId),
        or(eq(campaigns.utmCampaign, base), like(campaigns.utmCampaign, `${base}-%`)),
      ),
    );
  const used = new Set(taken.map((row) => row.utm));
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const text = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : "";
  return text.includes(constraint);
}

export async function createCampaign(
  db: Database,
  ctx: TenantContext,
  input: { name: string; placement: string; sitePublicId: string; destination: string },
): Promise<CampaignResult> {
  assertMutable(ctx);
  const name = cleanName(input.name);
  if (!name) return { ok: false, message: NAME_MESSAGE };
  if (!isPlacement(input.placement)) return { ok: false, message: "Pick where the code will be used." };

  const [site] = await db
    .select({ id: sites.id, productionUrl: sites.productionUrl, primaryDomain: sites.primaryDomain })
    .from(sites)
    .where(
      and(
        eq(sites.publicId, input.sitePublicId),
        eq(sites.organizationId, ctx.organizationId),
        isNull(sites.archivedAt),
      ),
    )
    .limit(1);
  if (!site) return { ok: false, message: "Pick one of your websites." };

  const origin = siteOrigin(site);
  if (!origin) {
    return {
      ok: false,
      message: "That website is not live at its own address yet, so a code would have nowhere to send people.",
    };
  }
  const destination = destinationFromInput(input.destination, origin);
  if (!destination.ok) return destination;

  const utmCampaign = await freeUtmCampaign(db, ctx, name);
  const publicId = newPublicId();

  for (let attempt = 1; attempt <= CODE_ATTEMPTS; attempt += 1) {
    try {
      await db.insert(campaigns).values({
        publicId,
        organizationId: ctx.organizationId,
        siteId: site.id,
        code: newCampaignCode(),
        name,
        placement: input.placement,
        destinationPath: destination.path,
        utmCampaign,
        createdBy: ctx.userId,
      });
      break;
    } catch (error) {
      if (attempt < CODE_ATTEMPTS && isUniqueViolation(error, "campaigns_code_key")) continue;
      throw error;
    }
  }

  await db.insert(auditLog).values({
    action: "campaign.created",
    entityType: "campaign",
    entityId: null,
    actorUserId: ctx.userId,
    organizationId: ctx.organizationId,
    metadata: { campaign: publicId, placement: input.placement },
  });
  return { ok: true, publicId };
}

export interface CampaignSummary {
  publicId: string;
  name: string;
  placement: CampaignPlacement;
  placementLabel: string;
  code: string;
  shortLink: string;
  printedLink: string;
  destinationPath: string;
  /** Where a scan lands, tagged. Null if the site has since lost its address. */
  destinationUrl: string | null;
  utmCampaign: string;
  siteName: string;
  paused: boolean;
  createdAt: Date;
}

export interface CampaignListItem extends CampaignSummary {
  scansInWindow: number;
  scansTotal: number;
  lastScanAt: Date | null;
  /** Scans per day across the window, oldest first: the row's sparkline. */
  daily: number[];
}

const SUMMARY_COLUMNS = {
  id: campaigns.id,
  publicId: campaigns.publicId,
  name: campaigns.name,
  placement: campaigns.placement,
  code: campaigns.code,
  destinationPath: campaigns.destinationPath,
  utmCampaign: campaigns.utmCampaign,
  pausedAt: campaigns.pausedAt,
  createdAt: campaigns.createdAt,
  siteName: sites.name,
  productionUrl: sites.productionUrl,
  primaryDomain: sites.primaryDomain,
};

interface SummaryRow {
  id: string;
  publicId: string;
  name: string;
  placement: string;
  code: string;
  destinationPath: string;
  utmCampaign: string;
  pausedAt: Date | null;
  createdAt: Date;
  siteName: string;
  productionUrl: string | null;
  primaryDomain: string | null;
}

function summarise(row: SummaryRow): CampaignSummary {
  const placement = isPlacement(row.placement) ? row.placement : "other";
  const origin = siteOrigin(row);
  return {
    publicId: row.publicId,
    name: row.name,
    placement,
    placementLabel: PLACEMENT_LABELS[placement],
    code: row.code,
    shortLink: shortLink(row.code),
    printedLink: printedLink(row.code),
    destinationPath: row.destinationPath,
    destinationUrl: origin
      ? destinationUrl({ origin, path: row.destinationPath, placement, utmCampaign: row.utmCampaign })
      : null,
    utmCampaign: row.utmCampaign,
    siteName: row.siteName,
    paused: row.pausedAt !== null,
    createdAt: row.createdAt,
  };
}

export async function listCampaigns(
  db: Database,
  ctx: TenantContext,
  { days = 30, now = new Date() }: { days?: number; now?: Date } = {},
): Promise<CampaignListItem[]> {
  const rows = await db
    .select(SUMMARY_COLUMNS)
    .from(campaigns)
    .innerJoin(sites, eq(sites.id, campaigns.siteId))
    .where(eq(campaigns.organizationId, ctx.organizationId))
    .orderBy(desc(campaigns.createdAt));
  if (rows.length === 0) return [];

  const counts = await scanCountsByCampaign(db, ctx.organizationId, { days, now });
  return rows.map((row) => {
    const count = counts.get(row.id);
    return {
      ...summarise(row),
      scansInWindow: count?.inWindow ?? 0,
      scansTotal: count?.total ?? 0,
      lastScanAt: count?.lastScanAt ?? null,
      daily: count?.daily ?? new Array<number>(days).fill(0),
    };
  });
}

export async function getCampaign(db: Database, ctx: TenantContext, publicId: string): Promise<CampaignSummary> {
  const [row] = await db
    .select(SUMMARY_COLUMNS)
    .from(campaigns)
    .innerJoin(sites, eq(sites.id, campaigns.siteId))
    .where(and(eq(campaigns.publicId, publicId), eq(campaigns.organizationId, ctx.organizationId)))
    .limit(1);
  if (!row) throw new NotFoundError();
  return summarise(row);
}

/**
 * Rename it, or send it somewhere else.
 *
 * The destination is the one thing a printed code can still change, which
 * is most of the point of a short link: a spring offer ends, the yard signs
 * stay up, and the code starts opening the summer page instead.
 * `utmCampaign` never changes; see the schema.
 */
export async function updateCampaign(
  db: Database,
  ctx: TenantContext,
  publicId: string,
  input: { name: string; destination: string },
): Promise<CampaignResult> {
  assertMutable(ctx);
  const name = cleanName(input.name);
  if (!name) return { ok: false, message: NAME_MESSAGE };

  const [row] = await db
    .select({ id: campaigns.id, productionUrl: sites.productionUrl, primaryDomain: sites.primaryDomain })
    .from(campaigns)
    .innerJoin(sites, eq(sites.id, campaigns.siteId))
    .where(and(eq(campaigns.publicId, publicId), eq(campaigns.organizationId, ctx.organizationId)))
    .limit(1);
  if (!row) return { ok: false, message: "That campaign no longer exists." };

  const origin = siteOrigin(row);
  if (!origin) return { ok: false, message: "That website has no address yet, so the page cannot be checked." };
  const destination = destinationFromInput(input.destination, origin);
  if (!destination.ok) return destination;

  await db
    .update(campaigns)
    .set({ name, destinationPath: destination.path, updatedAt: new Date() })
    .where(and(eq(campaigns.id, row.id), eq(campaigns.organizationId, ctx.organizationId)));
  return { ok: true, publicId };
}

/** Pausing stops the counting, never the redirect. */
export async function setCampaignPaused(
  db: Database,
  ctx: TenantContext,
  publicId: string,
  paused: boolean,
): Promise<void> {
  assertMutable(ctx);
  const now = new Date();
  const updated = await db
    .update(campaigns)
    .set({ pausedAt: paused ? now : null, updatedAt: now })
    .where(and(eq(campaigns.publicId, publicId), eq(campaigns.organizationId, ctx.organizationId)))
    .returning({ id: campaigns.id });
  if (updated.length === 0) throw new NotFoundError();
}

/**
 * Each campaign's analytics name and its site's Umami website id, for
 * attribution. Resolved from the session's organization, so a campaign can
 * only ever be looked up in its own site's analytics.
 */
export async function campaignAnalyticsTargets(
  db: Database,
  ctx: TenantContext,
): Promise<Map<string, { utmCampaign: string; websiteId: string | null }>> {
  const rows = await db
    .select({
      publicId: campaigns.publicId,
      utmCampaign: campaigns.utmCampaign,
      websiteId: analyticsConnections.umamiWebsiteId,
    })
    .from(campaigns)
    .innerJoin(sites, eq(sites.id, campaigns.siteId))
    .leftJoin(analyticsConnections, eq(analyticsConnections.siteId, sites.id))
    .where(eq(campaigns.organizationId, ctx.organizationId));
  return new Map(rows.map((row) => [row.publicId, { utmCampaign: row.utmCampaign, websiteId: row.websiteId }]));
}
