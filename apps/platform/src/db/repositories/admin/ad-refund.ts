import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import { adCampaignChannels, adCampaigns, auditLog, paymentAdjustments, paymentRequests, payments } from "@/db/schema";
import { requireStripe, stripeConfigured } from "@/lib/payments/stripe";
import { microsToCents, settleCampaign, type Settlement } from "@/lib/ads/money";
import { buildAdRefundEmail } from "@/lib/email/ad-updates";
import type { AdminContext } from "../context";
import { campaignUrl, tellClient } from "./ads";

/**
 * Settling a campaign: working out what it cost and giving the rest back.
 *
 * The rule is `settleCampaign` in `lib/ads/money.ts`, the same function the
 * checkout page's promise was written from: never ran, everything back; ran,
 * the unspent spend back and the fee worked out again on what was spent.
 *
 * ## Where the spend figure comes from
 *
 * From the platforms, through the stats sync, when every channel has synced.
 * In manual mode there is no sync, so the operator types the final spend from
 * the platform's own screen — and that figure is recorded in the audit log
 * beside the refund, because it is the number the client's money depends on.
 *
 * ## The money
 *
 * A card payment is refunded through Stripe, against its own payment intent,
 * with an idempotency key so a retried click cannot refund twice. Anything
 * else (cash, Venmo) is the operator's to pay back; the portal records that
 * they have. Either way a ledger adjustment is written, because the ledger
 * forbids changing a payment and a refund is a correction, not a deletion.
 */

export type RefundOutcome =
  | { ok: true; settlement: Settlement; refundReference: string | null }
  | { ok: false; message: string };

async function loadForSettlement(db: Database, publicId: string) {
  const [campaign] = await db.select().from(adCampaigns).where(eq(adCampaigns.publicId, publicId)).limit(1);
  if (!campaign) return null;
  const channels = await db
    .select({ spendMicros: adCampaignChannels.spendMicros, lastSyncedAt: adCampaignChannels.lastSyncedAt })
    .from(adCampaignChannels)
    .where(eq(adCampaignChannels.campaignId, campaign.id));
  const [payment] = campaign.paymentRequestId
    ? await db
        .select({ id: payments.id, method: payments.method, provider: payments.provider, providerReference: payments.providerReference })
        .from(paymentRequests)
        .innerJoin(payments, eq(payments.id, paymentRequests.paymentId))
        .where(eq(paymentRequests.id, campaign.paymentRequestId))
        .limit(1)
    : [];
  return { campaign, channels, payment: payment ?? null };
}

/** What settling would do now, for the operator to read before pressing the button. */
export async function previewSettlement(
  _ctx: AdminContext,
  db: Database,
  publicId: string,
  { finalSpendCents }: { finalSpendCents?: number } = {},
): Promise<{ settlement: Settlement; spendFrom: "sync" | "operator" | "none" } | null> {
  const loaded = await loadForSettlement(db, publicId);
  if (!loaded) return null;
  const { campaign, channels } = loaded;
  const synced = channels.length > 0 && channels.every((c) => c.lastSyncedAt);
  const launched = Boolean(campaign.launchedAt);
  const actual = launched
    ? (finalSpendCents ?? (synced ? microsToCents(channels.reduce((n, c) => n + c.spendMicros, 0)) : null))
    : 0;
  if (actual === null) return null;

  return {
    spendFrom: !launched ? "none" : finalSpendCents !== undefined ? "operator" : "sync",
    settlement: settleCampaign({
      spendCents: campaign.spendBudgetCents,
      feeCents: campaign.managementFeeCents,
      terms: { basisPoints: campaign.feeBasisPoints ?? 1500, minimumCents: campaign.feeMinimumCents ?? 2500 },
      actualSpendCents: actual,
      launched,
    }),
  };
}

export async function settleAndRefund(
  ctx: AdminContext,
  db: Database,
  publicId: string,
  input: { finalSpendCents?: number; refundedByHand?: boolean } = {},
  { now = new Date() }: { now?: Date } = {},
): Promise<RefundOutcome> {
  const loaded = await loadForSettlement(db, publicId);
  if (!loaded) return { ok: false, message: "Campaign not found." };
  const { campaign, channels, payment } = loaded;

  if (campaign.status !== "ended" && campaign.status !== "cancelled") {
    return { ok: false, message: "End the campaign before settling it." };
  }
  if (campaign.settledAt) return { ok: false, message: "This campaign is already settled." };
  if (!campaign.paidAt || !payment) return { ok: false, message: "There is no confirmed payment to refund against." };

  if (input.finalSpendCents !== undefined && (!Number.isInteger(input.finalSpendCents) || input.finalSpendCents < 0)) {
    return { ok: false, message: "Enter the final spend in dollars and cents." };
  }

  const synced = channels.length > 0 && channels.every((c) => c.lastSyncedAt);
  if (campaign.launchedAt && input.finalSpendCents === undefined && !synced) {
    return {
      ok: false,
      message: "Not every channel has reported its spend. Enter the final spend from Google Ads and Meta.",
    };
  }

  const preview = await previewSettlement(ctx, db, publicId, { finalSpendCents: input.finalSpendCents });
  if (!preview) return { ok: false, message: "Could not work out what this campaign spent." };
  const { settlement } = preview;
  const refundCents = settlement.refundCents - campaign.refundedCents;

  let refundReference: string | null = null;
  if (refundCents > 0) {
    if (payment.provider === "stripe") {
      if (!stripeConfigured()) return { ok: false, message: "Stripe is not configured here, so the refund can't be sent." };
      try {
        const stripe = requireStripe();
        // The ledger holds the payment intent, or the session when Stripe had
        // not attached an intent yet; a refund needs the intent.
        let intent = payment.providerReference;
        if (intent?.startsWith("cs_")) {
          const session = await stripe.checkout.sessions.retrieve(intent);
          intent = typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null);
        }
        if (!intent) return { ok: false, message: "No Stripe payment found to refund. Refund it in the Stripe dashboard." };

        const refund = await stripe.refunds.create(
          {
            payment_intent: intent,
            amount: refundCents,
            reason: "requested_by_customer",
            metadata: { ad_campaign_id: publicId, kind: campaign.launchedAt ? "unspent_budget" : "did_not_run" },
          },
          { idempotencyKey: `ad_refund:${publicId}:${campaign.refundedCents}` },
        );
        refundReference = refund.id;
      } catch (error) {
        console.error("[ads:refund] Stripe refund failed", {
          campaign: publicId,
          message: error instanceof Error ? error.message : "unknown",
        });
        return { ok: false, message: "Stripe refused the refund. Nothing was recorded; try again or refund in the dashboard." };
      }
    } else if (!input.refundedByHand) {
      return {
        ok: false,
        message: "This was paid outside Stripe. Pay the refund back by hand, then tick that you have.",
      };
    }

    await db.insert(paymentAdjustments).values({
      paymentId: payment.id,
      kind: "refund",
      amountCentsDelta: -refundCents,
      reason: campaign.launchedAt ? `Unspent ad budget, campaign ${publicId}` : `Ad campaign ${publicId} did not run`,
      createdBy: ctx.userId,
    });
  }

  const [settled] = await db
    .update(adCampaigns)
    .set({
      refundedCents: campaign.refundedCents + Math.max(0, refundCents),
      refundReference: refundReference ?? campaign.refundReference,
      settledAt: now,
      updatedAt: now,
    })
    .where(and(eq(adCampaigns.id, campaign.id), isNull(adCampaigns.settledAt)))
    .returning({ id: adCampaigns.id });
  if (!settled) return { ok: false, message: "This campaign is already settled." };

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: campaign.organizationId,
    action: "ads.campaign_settled",
    entityType: "ad_campaign",
    entityId: publicId,
    metadata: { ...settlement, refundedNow: Math.max(0, refundCents), spendFrom: preview.spendFrom, refundReference },
  });

  if (refundCents > 0) {
    await tellClient(db, campaign.organizationId, (contactName) =>
      buildAdRefundEmail({
        contactName,
        campaignName: campaign.name,
        campaignUrl: campaignUrl(publicId),
        refundCents,
        spentCents: settlement.keptSpendCents,
        feeCents: settlement.keptFeeCents,
        ranAtAll: Boolean(campaign.launchedAt),
      }),
    );
  }

  return { ok: true, settlement, refundReference };
}
