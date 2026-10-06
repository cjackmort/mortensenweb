import type Stripe from "stripe";
import { requireStripe } from "./stripe";

/**
 * Promotions, as Stripe promotion codes.
 *
 * A promo is made in the Stripe dashboard — a coupon ("50% off for 3 months")
 * and a code that redeems it ("SPRING50"), with whatever expiry, redemption
 * cap or first-time-only rule it needs. Nothing here creates one. The portal
 * only offers codes at checkout, attaches them for an operator, and reads back
 * what a subscription is actually paying, so the discount math lives in one
 * place — Stripe's — and cannot disagree with what is charged.
 *
 * Every read here is fault-tolerant on purpose. A promo is a nicety around a
 * payment; a Stripe hiccup while describing one must never be what stops a
 * client paying or a webhook being processed.
 */

/**
 * What a subscription retrieve needs for `describeDiscounts` to work.
 *
 * Discounts arrive as bare ids unless expanded, and a discount cannot be
 * fetched on its own afterwards — there is no discounts endpoint — so every
 * retrieve whose result is mirrored has to ask for them up front.
 */
export const SUBSCRIPTION_EXPAND = ["discounts"];

type CouponTerms = Pick<
  Stripe.Coupon,
  "percent_off" | "amount_off" | "duration" | "duration_in_months"
>;

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

/** "50% off for 3 months", "$25 off the first payment", "$10 off every month". */
export function couponTerms(coupon: CouponTerms): string {
  const off = coupon.percent_off
    ? `${coupon.percent_off}% off`
    : `${money(coupon.amount_off ?? 0)} off`;

  switch (coupon.duration) {
    case "once":
      return `${off} the first payment`;
    case "repeating": {
      const months = coupon.duration_in_months ?? 1;
      return `${off} for ${months} ${months === 1 ? "month" : "months"}`;
    }
    default:
      return `${off} every month`;
  }
}

/** A price after one coupon. Never below zero. */
export function applyCoupon(
  cents: number,
  coupon: Pick<Stripe.Coupon, "percent_off" | "amount_off">,
): number {
  if (coupon.percent_off) {
    return Math.max(0, Math.round((cents * (100 - coupon.percent_off)) / 100));
  }
  return Math.max(0, cents - (coupon.amount_off ?? 0));
}

export interface DiscountColumns {
  discountLabel: string | null;
  discountedPriceCents: number | null;
  discountEndsAt: Date | null;
}

const NO_DISCOUNT: DiscountColumns = {
  discountLabel: null,
  discountedPriceCents: null,
  discountEndsAt: null,
};

/**
 * Whether a mirrored discount still applies at `at`.
 *
 * Decided from the end date rather than trusted to be cleared: Stripe ending a
 * discount is not an event the receiver is guaranteed to see promptly, and a
 * billing page quoting an expired promo is wrong in the client's favour in a
 * way they would notice on the next charge.
 */
export function discountApplies(
  row: { discountedPriceCents: number | null; discountEndsAt: Date | null },
  at: Date = new Date(),
): boolean {
  if (row.discountedPriceCents === null) return false;
  return row.discountEndsAt === null || row.discountEndsAt > at;
}

/** What the client is charged per month at `at`: the promo price while it lasts. */
export function effectiveMonthlyCents(
  row: {
    monthlyPriceCents: number;
    discountedPriceCents: number | null;
    discountEndsAt: Date | null;
  },
  at: Date = new Date(),
): number {
  return discountApplies(row, at) ? row.discountedPriceCents! : row.monthlyPriceCents;
}

async function couponOf(
  stripe: Stripe,
  coupon: string | Stripe.Coupon | null | undefined,
): Promise<Stripe.Coupon | null> {
  if (!coupon) return null;
  return typeof coupon === "string" ? stripe.coupons.retrieve(coupon) : coupon;
}

async function codeOf(
  stripe: Stripe,
  promo: string | Stripe.PromotionCode | null | undefined,
): Promise<string | null> {
  if (!promo) return null;
  const found = typeof promo === "string" ? await stripe.promotionCodes.retrieve(promo) : promo;
  return found.code;
}

/**
 * The promo a subscription is on, as the columns the portal mirrors.
 *
 * All-null when there is no discount. `undefined` when it could not be worked
 * out — the subscription was retrieved without `SUBSCRIPTION_EXPAND`, or
 * Stripe failed to answer — which callers take as "leave what is stored",
 * because writing nulls would wipe a discount the client still has.
 */
export async function describeDiscounts(
  subscription: Pick<Stripe.Subscription, "discounts">,
  listPriceCents: number,
): Promise<DiscountColumns | undefined> {
  const discounts = subscription.discounts ?? [];
  if (discounts.length === 0) return NO_DISCOUNT;
  if (discounts.some((d) => typeof d === "string")) return undefined;

  try {
    const stripe = requireStripe();
    let cents = listPriceCents;
    let endsAt: Date | null = null;
    const labels: string[] = [];

    for (const discount of discounts as Stripe.Discount[]) {
      const coupon = await couponOf(stripe, discount.source?.coupon);
      if (!coupon) continue;
      cents = applyCoupon(cents, coupon);

      const code = await codeOf(stripe, discount.promotion_code);
      const name = code ?? coupon.name ?? "Promo";
      labels.push(`${name}: ${couponTerms(coupon)}`);

      // The earliest end, because that is when the price next changes.
      if (discount.end) {
        const end = new Date(discount.end * 1000);
        if (!endsAt || end < endsAt) endsAt = end;
      }
    }

    if (labels.length === 0) return NO_DISCOUNT;
    return {
      discountLabel: labels.join("; "),
      discountedPriceCents: cents,
      discountEndsAt: endsAt,
    };
  } catch (error) {
    console.error("[promos] could not describe discount", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return undefined;
  }
}

export interface PromoOption {
  /** The promotion code's Stripe id, `promo_…`. */
  id: string;
  /** What a client would type: `SPRING50`. */
  code: string;
  terms: string;
  /** When the code stops working, if it does. */
  expiresAt: Date | null;
  firstTimeOnly: boolean;
}

function usable(promo: Stripe.PromotionCode, coupon: Stripe.Coupon | null): boolean {
  if (!promo.active || !coupon?.valid) return false;
  if (promo.expires_at && promo.expires_at * 1000 <= Date.now()) return false;
  if (promo.max_redemptions !== null && promo.times_redeemed >= promo.max_redemptions) {
    return false;
  }
  return true;
}

function optionFrom(promo: Stripe.PromotionCode, coupon: Stripe.Coupon): PromoOption {
  const expiry = promo.expires_at ?? coupon.redeem_by;
  return {
    id: promo.id,
    code: promo.code,
    terms: couponTerms(coupon),
    expiresAt: expiry ? new Date(expiry * 1000) : null,
    firstTimeOnly: promo.restrictions?.first_time_transaction ?? false,
  };
}

/**
 * Codes an operator can attach to a client, newest first.
 *
 * Customer-specific codes are left out: Stripe only honours one for the
 * customer it names, so offering it for anybody else would fail at checkout.
 * Empty, not an error, when Stripe cannot be reached — the page around it
 * still has to load.
 */
export async function listPromoOptions(): Promise<PromoOption[]> {
  try {
    const stripe = requireStripe();
    const found = await stripe.promotionCodes.list({ active: true, limit: 100 });
    const coupons = new Map<string, Stripe.Coupon | null>();
    const options: PromoOption[] = [];

    for (const promo of found.data) {
      if (promo.customer) continue;
      const ref = promo.promotion?.coupon;
      const id = typeof ref === "string" ? ref : (ref?.id ?? null);
      if (!id) continue;
      if (!coupons.has(id)) coupons.set(id, await couponOf(stripe, ref));
      const coupon = coupons.get(id) ?? null;
      if (coupon && usable(promo, coupon)) options.push(optionFrom(promo, coupon));
    }

    return options;
  } catch (error) {
    console.error("[promos] could not list promotion codes", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return [];
  }
}

/**
 * The promotion code, if it can still be redeemed right now. Null otherwise —
 * including when Stripe cannot be reached, so a checkout carries on without
 * the promo rather than not at all.
 */
export async function usablePromo(promotionCodeId: string): Promise<PromoOption | null> {
  try {
    const stripe = requireStripe();
    const promo = await stripe.promotionCodes.retrieve(promotionCodeId);
    const coupon = await couponOf(stripe, promo.promotion?.coupon);
    if (!coupon || !usable(promo, coupon)) return null;
    return optionFrom(promo, coupon);
  } catch (error) {
    console.error("[promos] could not read promotion code", {
      promotionCodeId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return null;
  }
}
