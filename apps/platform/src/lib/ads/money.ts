import {
  AD_DURATIONS_DAYS,
  adChannel,
  channelMinimumCents,
  dollars,
  feeTermsLabel,
  isAdChannelKey,
  managementFeeCents,
  type AdChannelKey,
  type AdFeeTerms,
} from "@mortensenweb/plans";

/**
 * An ad campaign's money: what the client is asked to pay, and what they get
 * back when it ends. Pure, so the checkout page, the Stripe line items and the
 * operator's refund all work from the one calculation.
 */

export interface ChannelBudget {
  channel: AdChannelKey;
  budgetCents: number;
}

export type BudgetCheck =
  | { ok: true; spendCents: number }
  | { ok: false; errors: Partial<Record<AdChannelKey | "form", string>> };

export function isDuration(days: number): days is (typeof AD_DURATIONS_DAYS)[number] {
  return (AD_DURATIONS_DAYS as readonly number[]).includes(days);
}

/** Every chosen channel at or above its minimum for the chosen length. */
export function validateBudgets(channels: ChannelBudget[], days: number): BudgetCheck {
  if (!isDuration(days)) {
    return { ok: false, errors: { form: "Choose how long the ad runs." } };
  }
  if (channels.length === 0) {
    return { ok: false, errors: { form: "Choose at least one place for your ad to run." } };
  }

  const errors: Partial<Record<AdChannelKey | "form", string>> = {};
  const seen = new Set<AdChannelKey>();

  for (const { channel, budgetCents } of channels) {
    if (!isAdChannelKey(channel)) {
      errors.form = "That isn't a place we run ads.";
      continue;
    }
    if (seen.has(channel)) {
      errors.form = "Each place can only be chosen once.";
      continue;
    }
    seen.add(channel);

    const minimum = channelMinimumCents(adChannel(channel), days);
    if (!Number.isInteger(budgetCents) || budgetCents < minimum) {
      errors[channel] = `${adChannel(channel).name} needs at least ${dollars(minimum)} for ${days} days.`;
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, spendCents: channels.reduce((sum, c) => sum + c.budgetCents, 0) };
}

export interface CheckoutLine {
  kind: "spend" | "fee";
  label: string;
  cents: number;
}

export interface CheckoutLines {
  items: CheckoutLine[];
  spendCents: number;
  feeCents: number;
  totalCents: number;
}

/**
 * The lines the client sees and pays: one per channel's spend, then the fee.
 * The same list becomes the Stripe Checkout line items, so the receipt says
 * exactly what the summary said.
 */
export function checkoutLines(input: { channels: ChannelBudget[]; terms: AdFeeTerms }): CheckoutLines {
  const spend = input.channels.map((c) => ({
    kind: "spend" as const,
    label: `Ad spend: ${adChannel(c.channel).name}`,
    cents: c.budgetCents,
  }));
  const spendCents = spend.reduce((sum, line) => sum + line.cents, 0);
  const feeCents = managementFeeCents(spendCents, input.terms);

  return {
    items: [
      ...spend,
      { kind: "fee", label: `Management fee (${feeTermsLabel(input.terms)})`, cents: feeCents },
    ],
    spendCents,
    feeCents,
    totalCents: spendCents + feeCents,
  };
}

export interface Settlement {
  /** Ad spend the client pays for: what ran, never more than they paid. */
  keptSpendCents: number;
  keptFeeCents: number;
  refundCents: number;
}

/**
 * What a campaign costs once it is over, and what goes back.
 *
 * A campaign that never launched costs nothing: the fee is for running it.
 * One that launched keeps the fee on what it actually spent, with the floor —
 * setting a campaign up is the same work however little it went on to spend.
 * Spend is capped at the budget paid: a platform that overshoots by a few
 * dollars on the last day is ours to absorb, not a surprise for the client.
 */
export function settleCampaign(input: {
  spendCents: number;
  feeCents: number;
  terms: AdFeeTerms;
  actualSpendCents: number;
  launched: boolean;
}): Settlement {
  if (!input.launched) {
    return { keptSpendCents: 0, keptFeeCents: 0, refundCents: input.spendCents + input.feeCents };
  }

  const keptSpendCents = Math.min(Math.max(0, input.actualSpendCents), input.spendCents);
  const recomputed = Math.max(
    Math.round((keptSpendCents * input.terms.basisPoints) / 10000),
    input.terms.minimumCents,
  );
  const keptFeeCents = Math.min(recomputed, input.feeCents);

  return {
    keptSpendCents,
    keptFeeCents,
    refundCents: input.spendCents - keptSpendCents + (input.feeCents - keptFeeCents),
  };
}

/** Micros, as both platforms' spend arrives, to whole cents. */
export function microsToCents(micros: number): number {
  return Math.round(micros / 10_000);
}
