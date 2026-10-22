import { count, inArray, sql, type SQL } from "drizzle-orm";
import type { Database } from "@/db/client";
import { winbackRecipients } from "@/db/schema";

/**
 * Results per win-back campaign, counted from its recipient rows.
 *
 * Shared by the client and admin repositories, neither of which owns it: the
 * caller passes campaign ids it has already scoped, and the client side adds
 * its own organization filter on top (`extra`). Every figure is a count of
 * stamped rows, so a campaign nobody has opened yet reads 0 opened only once
 * it has actually been delivered — the page shows "not sent yet" before that,
 * never a zero that looks like a result.
 */

export interface CampaignStats {
  /** Everyone it is addressed to. */
  total: number;
  /** Handed to Resend. */
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  unsubscribed: number;
  bounced: number;
  complained: number;
  /** Skipped at send time: unsubscribed, bounced or complained before. */
  suppressed: number;
  failed: number;
  /** Not reached yet. */
  waiting: number;
  /** This server has no mail provider: recorded, not emailed. */
  notSent: number;
  /** Stopped before they were sent. */
  halted: number;
}

export const EMPTY_STATS: CampaignStats = {
  total: 0,
  sent: 0,
  delivered: 0,
  opened: 0,
  clicked: 0,
  unsubscribed: 0,
  bounced: 0,
  complained: 0,
  suppressed: 0,
  failed: 0,
  waiting: 0,
  notSent: 0,
  halted: 0,
};

const r = winbackRecipients;

function countWhere(condition: SQL) {
  return sql<number>`count(*) filter (where ${condition})`.mapWith(Number);
}

export async function statsFor(
  db: Database,
  campaignIds: string[],
  extra?: SQL,
): Promise<Map<string, CampaignStats>> {
  const result = new Map<string, CampaignStats>();
  if (campaignIds.length === 0) return result;

  const rows = await db
    .select({
      campaignId: r.campaignId,
      total: count(),
      sent: countWhere(sql`${r.sentAt} is not null`),
      delivered: countWhere(sql`${r.deliveredAt} is not null`),
      opened: countWhere(sql`${r.openedAt} is not null`),
      clicked: countWhere(sql`${r.clickedAt} is not null`),
      unsubscribed: countWhere(sql`${r.unsubscribedAt} is not null`),
      bounced: countWhere(sql`${r.bouncedAt} is not null`),
      complained: countWhere(sql`${r.complainedAt} is not null`),
      suppressed: countWhere(sql`${r.status} = 'suppressed'`),
      failed: countWhere(sql`${r.status} = 'failed'`),
      waiting: countWhere(sql`${r.status} in ('pending', 'sending')`),
      notSent: countWhere(sql`${r.status} = 'not_sent'`),
      halted: countWhere(sql`${r.status} = 'halted'`),
    })
    .from(r)
    .where(extra ? sql`${inArray(r.campaignId, campaignIds)} and ${extra}` : inArray(r.campaignId, campaignIds))
    .groupBy(r.campaignId);

  for (const row of rows) {
    const { campaignId, ...stats } = row;
    result.set(campaignId, stats);
  }
  return result;
}
