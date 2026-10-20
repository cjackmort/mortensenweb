import { and, eq, inArray } from "drizzle-orm";
import type Stripe from "stripe";
import { AD_MANAGEMENT_FEE, type AdChannelKey } from "@mortensenweb/plans";
import type { Database } from "@/db/client";
import { adCampaignChannels, adCampaigns, paymentRequests } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { generatePaymentReference } from "@/lib/payments/venmo";
import { requireStripe, stripeConfigured } from "@/lib/payments/stripe";
import { checkoutLines, validateBudgets } from "@/lib/ads/money";
import { creativeProblems } from "@/lib/ads/creative";
import { assertMutable, NotFoundError, type TenantContext } from "../context";
import { ensureCustomer, resolveClient } from "./stripe-checkout";
import { durationDays } from "./ads";

/**
 * Paying for an ad campaign, through Stripe Checkout.
 *
 * One payment covers the campaign: a line per channel's ad spend and the
 * management fee as a line of its own, so the Stripe page and the receipt say
 * what the portal's summary said. Behind it is an ordinary payment request
 * (an invoice), which is what lets the existing webhook settle it — the
 * session carries the request's id, `settleOneOffCheckout` confirms it, and
 * `confirmPaymentReceived` moves the campaign on to review. Nothing here
 * marks anything paid.
 *
 * ## What the browser decides
 *
 * Which campaign. The amounts, the fee terms and the customer all come from
 * the database, and the campaign is found inside the session's tenant.
 *
 * ## One checkout per campaign
 *
 * The open session is reused, as for any invoice, so a double click lands on
 * the same page. A completed one means money is on its way and nothing new is
 * started. Going back to edit expires the session and cancels the invoice,
 * because otherwise an old tab could still pay for an ad that has changed.
 */

export type AdCheckoutOutcome =
  | { ok: true; url: string; reused: boolean }
  | {
      ok: false;
      reason:
        | "not_configured"
        | "no_client"
        | "not_ready"
        | "not_payable"
        | "processing"
        | "stripe_failed";
      message: string;
    };

async function loadForCheckout(db: Database, ctx: TenantContext, publicId: string) {
  const [campaign] = await db
    .select()
    .from(adCampaigns)
    .where(and(eq(adCampaigns.publicId, publicId), eq(adCampaigns.organizationId, ctx.organizationId)))
    .limit(1);
  if (!campaign) throw new NotFoundError();

  const channels = await db
    .select({ channel: adCampaignChannels.channel, budgetCents: adCampaignChannels.budgetCents })
    .from(adCampaignChannels)
    .where(eq(adCampaignChannels.campaignId, campaign.id));

  return {
    campaign,
    channels: channels.map((c) => ({ channel: c.channel as AdChannelKey, budgetCents: c.budgetCents })),
  };
}

async function linkedRequest(db: Database, id: string | null) {
  if (!id) return null;
  const [row] = await db
    .select({
      id: paymentRequests.id,
      publicId: paymentRequests.publicId,
      reference: paymentRequests.reference,
      status: paymentRequests.status,
      amountCents: paymentRequests.amountCents,
      provider: paymentRequests.provider,
      providerReference: paymentRequests.providerReference,
    })
    .from(paymentRequests)
    .where(eq(paymentRequests.id, id))
    .limit(1);
  return row ?? null;
}

async function insertRequest(
  db: Database,
  input: { clientId: string; amountCents: number; note: string },
) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const [row] = await db
        .insert(paymentRequests)
        .values({
          publicId: newPublicId(),
          clientId: input.clientId,
          reference: generatePaymentReference(),
          amountCents: input.amountCents,
          status: "open",
          method: "stripe",
          provider: "stripe",
          purpose: "other",
          note: input.note,
        })
        .returning({
          id: paymentRequests.id,
          publicId: paymentRequests.publicId,
          reference: paymentRequests.reference,
        });
      return row!;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!/reference/i.test(message)) throw error;
    }
  }
  throw new Error("Could not allocate a unique payment reference.");
}

export async function beginAdCheckout(
  db: Database,
  ctx: TenantContext,
  publicId: string,
  urls: { successUrl: string; cancelUrl: string },
): Promise<AdCheckoutOutcome> {
  assertMutable(ctx);
  const { campaign, channels } = await loadForCheckout(db, ctx, publicId);

  if (campaign.status !== "draft" && campaign.status !== "awaiting_payment") {
    return { ok: false, reason: "not_payable", message: "This ad is already paid for." };
  }

  const problems = creativeProblems(campaign);
  const days = durationDays(campaign.startsOn, campaign.endsOn) ?? 0;
  const budgets = validateBudgets(channels, days);
  if (problems.length > 0 || !budgets.ok) {
    return {
      ok: false,
      reason: "not_ready",
      message: "Finish the ad and choose where it runs before paying.",
    };
  }

  if (!stripeConfigured()) {
    return {
      ok: false,
      reason: "not_configured",
      message: "Card payments are not set up yet. Please get in touch and we'll take it from there.",
    };
  }

  const client = await resolveClient(db, ctx);
  if (!client) {
    return { ok: false, reason: "no_client", message: "Your account is not linked to a client record." };
  }

  // A checkout already started for this campaign: hand it back, or wait for it.
  const existing = await linkedRequest(db, campaign.paymentRequestId);
  const stripe = requireStripe();
  if (campaign.status === "awaiting_payment" && existing?.providerReference) {
    try {
      const session = await stripe.checkout.sessions.retrieve(existing.providerReference);
      if (session.status === "complete") {
        return {
          ok: false,
          reason: "processing",
          message: "Your payment is going through. It can take a minute to show here.",
        };
      }
      if (session.status === "open" && session.url) return { ok: true, url: session.url, reused: true };
    } catch (error) {
      console.error("[ads:checkout] could not read the existing session", {
        campaign: campaign.publicId,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  // The fee terms are fixed here, at the moment the client agrees to them.
  const terms = AD_MANAGEMENT_FEE;
  const lines = checkoutLines({ channels, terms });

  try {
    const request =
      existing && existing.status === "open" && existing.amountCents === lines.totalCents
        ? existing
        : await insertRequest(db, {
            clientId: campaign.clientId,
            amountCents: lines.totalCents,
            note: `Ad campaign: ${campaign.name}`,
          });

    const customerId = await ensureCustomer(db, client);
    const metadata = {
      client_id: client.clientId,
      client_public_id: client.publicId,
      payment_request_id: request.publicId,
      purpose: "ad_campaign",
      ad_campaign_id: campaign.publicId,
      reference: request.reference,
    };

    const session: Stripe.Checkout.Session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        customer: customerId,
        line_items: lines.items.map((line) => ({
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: line.cents,
            product_data: { name: line.label },
          },
        })),
        success_url: urls.successUrl,
        cancel_url: urls.cancelUrl,
        client_reference_id: client.publicId,
        metadata,
        payment_intent_data: {
          metadata,
          description: `Ad campaign "${campaign.name}" (ref ${request.reference})`,
        },
      },
      {
        idempotencyKey: `ad_campaign:${campaign.publicId}:${request.publicId}:after:${
          existing?.providerReference ?? "none"
        }`,
      },
    );

    if (!session.url) {
      return { ok: false, reason: "stripe_failed", message: "Stripe did not return a payment page. Please try again." };
    }

    await db
      .update(paymentRequests)
      .set({ providerReference: session.id, checkoutUrl: session.url, updatedAt: new Date() })
      .where(eq(paymentRequests.id, request.id));

    await db
      .update(adCampaigns)
      .set({
        status: "awaiting_payment",
        paymentRequestId: request.id,
        spendBudgetCents: lines.spendCents,
        managementFeeCents: lines.feeCents,
        feeBasisPoints: terms.basisPoints,
        feeMinimumCents: terms.minimumCents,
        updatedAt: new Date(),
      })
      .where(eq(adCampaigns.id, campaign.id));

    return { ok: true, url: session.url, reused: false };
  } catch (error) {
    console.error("[ads:checkout] failed", {
      campaign: campaign.publicId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return {
      ok: false,
      reason: "stripe_failed",
      message: "We couldn't start the payment just now. Please try again shortly.",
    };
  }
}

export type ReopenOutcome = { ok: true } | { ok: false; message: string };

/**
 * Back to a draft from an unpaid checkout, so the client can change the ad.
 *
 * Refused once Stripe has the money: from there the campaign belongs to
 * review, and changes go through the operator.
 */
export async function reopenCampaign(db: Database, ctx: TenantContext, publicId: string): Promise<ReopenOutcome> {
  assertMutable(ctx);
  const { campaign } = await loadForCheckout(db, ctx, publicId);
  if (campaign.status === "draft") return { ok: true };
  if (campaign.status !== "awaiting_payment") {
    return { ok: false, message: "This ad is paid for. To change it, get in touch." };
  }

  const request = await linkedRequest(db, campaign.paymentRequestId);
  if (request?.provider === "stripe" && request.providerReference && stripeConfigured()) {
    const stripe = requireStripe();
    const session = await stripe.checkout.sessions.retrieve(request.providerReference);
    if (session.status === "complete") {
      return { ok: false, message: "Your payment is going through, so this ad can't be changed now." };
    }
    if (session.status === "open") await stripe.checkout.sessions.expire(session.id);
  }

  if (request) {
    await db
      .update(paymentRequests)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(paymentRequests.id, request.id), inArray(paymentRequests.status, ["open", "overdue"])));
  }

  await db
    .update(adCampaigns)
    .set({ status: "draft", paymentRequestId: null, updatedAt: new Date() })
    .where(and(eq(adCampaigns.id, campaign.id), eq(adCampaigns.status, "awaiting_payment")));

  return { ok: true };
}
