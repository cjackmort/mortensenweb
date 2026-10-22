import { desc, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { campaigns, clients, sites } from "@/db/schema";
import { PLACEMENT_LABELS, printedLink } from "@/lib/campaigns/links";
import type { CampaignPlacement } from "@/db/schema";
import { scanCountsByCampaign } from "../client/campaign-stats";
import { NotFoundError, type AdminContext } from "../context";

/**
 * One client's campaigns, for the operator's client page: what they have
 * printed and whether anyone is scanning it.
 */

export interface AdminCampaignRow {
  publicId: string;
  name: string;
  placementLabel: string;
  printedLink: string;
  siteName: string;
  paused: boolean;
  createdAt: Date;
  scansInWindow: number;
  scansTotal: number;
  lastScanAt: Date | null;
}

export async function listClientCampaigns(
  _ctx: AdminContext,
  db: Database,
  clientPublicId: string,
  { days = 30, now = new Date() }: { days?: number; now?: Date } = {},
): Promise<AdminCampaignRow[]> {
  const [client] = await db
    .select({ organizationId: clients.organizationId })
    .from(clients)
    .where(eq(clients.publicId, clientPublicId))
    .limit(1);
  if (!client) throw new NotFoundError();

  const rows = await db
    .select({
      id: campaigns.id,
      publicId: campaigns.publicId,
      name: campaigns.name,
      placement: campaigns.placement,
      code: campaigns.code,
      pausedAt: campaigns.pausedAt,
      createdAt: campaigns.createdAt,
      siteName: sites.name,
    })
    .from(campaigns)
    .innerJoin(sites, eq(sites.id, campaigns.siteId))
    .where(eq(campaigns.organizationId, client.organizationId))
    .orderBy(desc(campaigns.createdAt));
  if (rows.length === 0) return [];

  const counts = await scanCountsByCampaign(db, client.organizationId, { days, now });
  return rows.map((row) => {
    const count = counts.get(row.id);
    return {
      publicId: row.publicId,
      name: row.name,
      placementLabel: PLACEMENT_LABELS[row.placement as CampaignPlacement] ?? row.placement,
      printedLink: printedLink(row.code),
      siteName: row.siteName,
      paused: row.pausedAt !== null,
      createdAt: row.createdAt,
      scansInWindow: count?.inWindow ?? 0,
      scansTotal: count?.total ?? 0,
      lastScanAt: count?.lastScanAt ?? null,
    };
  });
}
