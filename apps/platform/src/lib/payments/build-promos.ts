import type Stripe from "stripe";
import { applyCoupon, couponTerms } from "./promos";
import { requireStripe } from "./stripe";

/**
 * Promo codes for the website price, and only the website price.
 *
 * A promo is still a Stripe promotion code over a coupon, and Stripe still
 * does the discount maths at checkout (see `promos.ts`). What this adds is
 * the rule the cart depends on: a code the client types there must come off
 * the build and nothing else. That is decided by the coupon's
 * `applies_to.products` being exactly the "Website build" product. A coupon
 * with no restriction applies to every line, so taken at the cart it would
 * also come off the plan — for one payment, or for ever, depending on how it
 * was made in the dashboard. Those are refused with a plain reason rather
 * than quietly applied.
 *
 * Codes made from the portal's own page (`createBuildPromo`) are built that
 * way. Codes made in the Stripe dashboard keep working when they were
 * restricted to the build product there.
 */

export interface BuildPromo {
  /** The promotion code's Stripe id, `promo_…`. */
  id: string;
  /** What the client typed, as Stripe stores it. */
  code: string;
  /** "$100 off the website", "25% off the website". */
  terms: string;
}

export type BuildPromoRefusal =
  | "empty"
  | "not_found"
  | "expired"
  | "used_up"
  | "not_build_only"
  | "not_applicable"
  | "unavailable";

export type BuildPromoCheck =
  | { ok: true; promo: BuildPromo; buildDueCents: number }
  | { ok: false; reason: BuildPromoRefusal; message: string };

const MESSAGES: Record<BuildPromoRefusal, string> = {
  empty: "Type a code first.",
  not_found: "We don't recognise that code. Check the spelling, or ask us for a new one.",
  expired: "That code has expired.",
  used_up: "That code has been used up.",
  not_build_only:
    "That code would also come off your monthly payments, so it can't be used here. Codes here only come off the website price.",
  not_applicable: "That code doesn't apply to this website price.",
  unavailable: "We couldn't check that code just now. Please try again in a minute.",
};

function refuse(reason: BuildPromoRefusal): BuildPromoCheck {
  return { ok: false, reason, message: MESSAGES[reason] };
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0 })}`;
}

/** "$100 off the website". Build-only coupons are one-off, so no duration. */
export function buildTerms(coupon: Pick<Stripe.Coupon, "percent_off" | "amount_off">): string {
  return coupon.percent_off ? `${coupon.percent_off}% off the website` : `${money(coupon.amount_off ?? 0)} off the website`;
}

/** Whether a coupon can only ever come off the build product. */
export function isBuildOnly(coupon: Pick<Stripe.Coupon, "applies_to">, buildProductId: string): boolean {
  const products = coupon.applies_to?.products ?? [];
  return products.length === 1 && products[0] === buildProductId;
}

function couponIdOf(promo: Stripe.PromotionCode): string | null {
  const ref = promo.promotion?.coupon;
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

/** The coupon with `applies_to`, which Stripe only returns when asked for. */
async function couponWithScope(stripe: Stripe, id: string): Promise<Stripe.Coupon> {
  return stripe.coupons.retrieve(id, { expand: ["applies_to"] });
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function expired(promo: Stripe.PromotionCode, coupon: Stripe.Coupon): boolean {
  if (!promo.active || !coupon.valid) return true;
  if (promo.expires_at && promo.expires_at <= nowSeconds()) return true;
  return Boolean(coupon.redeem_by && coupon.redeem_by <= nowSeconds());
}

function usedUp(promo: Stripe.PromotionCode, coupon: Stripe.Coupon): boolean {
  if (promo.max_redemptions !== null && promo.times_redeemed >= promo.max_redemptions) return true;
  return coupon.max_redemptions !== null && coupon.times_redeemed >= coupon.max_redemptions;
}

export interface BuildPromoContext {
  /** The "Website build" product. */
  buildProductId: string;
  /** What this client's build costs before the promo. */
  buildCents: number;
  /** Their Stripe customer, when they have one; a code made for somebody else is unknown here. */
  customerId: string | null;
}

/**
 * Whether a typed code can come off this client's build, and by how much.
 *
 * Read from Stripe every time — never cached, never trusted from the browser —
 * because codes are switched off and run out between one page view and the
 * next. When Stripe cannot be reached the answer is "could not check", never
 * "fine": a discount nobody verified is a discount nobody agreed to.
 */
export async function checkBuildPromo(raw: string, context: BuildPromoContext): Promise<BuildPromoCheck> {
  const code = raw.trim();
  if (!code) return refuse("empty");

  try {
    const stripe = requireStripe();
    const found = await stripe.promotionCodes.list({ code, limit: 10 });
    const candidates = found.data.filter((p) => !p.customer || p.customer === context.customerId);
    if (candidates.length === 0) return refuse("not_found");

    // Several codes can share a name over time; the live one wins.
    const promo = candidates.find((p) => p.active) ?? candidates[0]!;
    const couponId = couponIdOf(promo);
    if (!couponId) return refuse("not_found");
    const coupon = await couponWithScope(stripe, couponId);

    if (expired(promo, coupon)) return refuse("expired");
    if (usedUp(promo, coupon)) return refuse("used_up");
    if (!isBuildOnly(coupon, context.buildProductId)) return refuse("not_build_only");
    if (coupon.amount_off && (coupon.currency ?? "usd").toLowerCase() !== "usd") return refuse("not_applicable");
    const minimum = promo.restrictions?.minimum_amount ?? null;
    if (minimum !== null && context.buildCents < minimum) return refuse("not_applicable");

    return {
      ok: true,
      promo: { id: promo.id, code: promo.code, terms: buildTerms(coupon) },
      buildDueCents: applyCoupon(context.buildCents, coupon),
    };
  } catch (error) {
    console.error("[build-promos] could not check a code", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return refuse("unavailable");
  }
}

// ---------------------------------------------------------------------------
// The operator's side
// ---------------------------------------------------------------------------

export interface NewBuildPromo {
  code: string;
  kind: "amount" | "percent";
  /** Cents for an amount off; whole percent for a percentage. */
  value: number;
  expiresAt?: Date | null;
  maxRedemptions?: number | null;
}

export type CreateBuildPromoResult = { ok: true; id: string; code: string; terms: string } | { ok: false; message: string };

const CODE_PATTERN = /^[A-Za-z0-9-]{3,40}$/;

function invalidPromo(input: NewBuildPromo): string | null {
  if (!CODE_PATTERN.test(input.code)) return "Codes are 3 to 40 letters, numbers and dashes, with no spaces.";
  if (!Number.isInteger(input.value)) return "Use a whole number.";
  if (input.kind === "percent" && (input.value < 1 || input.value > 100)) {
    return "A percentage has to be between 1 and 100.";
  }
  if (input.kind === "amount" && input.value < 1) return "An amount off has to be more than $0.";
  if (input.maxRedemptions !== undefined && input.maxRedemptions !== null && input.maxRedemptions < 1) {
    return "A code has to be usable at least once. Leave the limit empty for no limit.";
  }
  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) return "The expiry date has to be in the future.";
  return null;
}

/**
 * A new code that can only come off the website price.
 *
 * A one-off (`duration: "once"`) coupon restricted to the build product, and
 * a promotion code for it. One-off because the build is paid once: a coupon
 * that lasted longer would sit on the client's subscription after checkout
 * doing nothing, and read as a discount on the billing page.
 */
export async function createBuildPromo(
  input: NewBuildPromo,
  context: { buildProductId: string },
): Promise<CreateBuildPromoResult> {
  const problem = invalidPromo(input);
  if (problem) return { ok: false, message: problem };

  const code = input.code.toUpperCase();
  const terms = buildTerms(
    input.kind === "percent" ? { percent_off: input.value, amount_off: null } : { percent_off: null, amount_off: input.value },
  );

  try {
    const stripe = requireStripe();
    // Checked first so a clash does not leave an orphan coupon behind.
    const clash = await stripe.promotionCodes.list({ code, active: true, limit: 1 });
    if (clash.data.length > 0) return { ok: false, message: `${code} is already in use. Pick another code.` };

    const coupon = await stripe.coupons.create(
      {
        ...(input.kind === "percent" ? { percent_off: input.value } : { amount_off: input.value, currency: "usd" }),
        duration: "once",
        name: `${code}: ${terms}`.slice(0, 40),
        applies_to: { products: [context.buildProductId] },
        metadata: { build_only: "true", source: "mortensenweb-portal" },
      },
      { idempotencyKey: `build-promo:${code}:${input.kind}:${input.value}` },
    );

    const promo = await stripe.promotionCodes.create({
      promotion: { type: "coupon", coupon: coupon.id },
      code,
      ...(input.expiresAt ? { expires_at: Math.floor(input.expiresAt.getTime() / 1000) } : {}),
      ...(input.maxRedemptions ? { max_redemptions: input.maxRedemptions } : {}),
      metadata: { build_only: "true", source: "mortensenweb-portal" },
    });

    return { ok: true, id: promo.id, code: promo.code, terms };
  } catch (error) {
    console.error("[build-promos] could not create a code", {
      message: error instanceof Error ? error.message : "unknown",
    });
    const type = (error as { type?: string } | null)?.type;
    return {
      ok: false,
      message:
        type === "StripeInvalidRequestError" && error instanceof Error
          ? `Stripe refused that code: ${error.message}`
          : "Stripe could not be reached. Nothing was created; try again in a minute.",
    };
  }
}

export interface BuildPromoRow {
  id: string;
  code: string;
  terms: string;
  /** Whether it can be used in the cart: restricted to the website price. */
  buildOnly: boolean;
  expiresAt: Date | null;
  maxRedemptions: number | null;
  timesRedeemed: number;
  /** Made for one customer only. */
  forOneCustomer: boolean;
}

/** Every live code, newest first, marked by whether the cart accepts it. */
export async function listBuildPromos(context: { buildProductId: string }): Promise<BuildPromoRow[]> {
  const stripe = requireStripe();
  const found = await stripe.promotionCodes.list({ active: true, limit: 100 });
  const coupons = new Map<string, Stripe.Coupon>();
  const rows: BuildPromoRow[] = [];

  for (const promo of found.data) {
    const couponId = couponIdOf(promo);
    if (!couponId) continue;
    if (!coupons.has(couponId)) coupons.set(couponId, await couponWithScope(stripe, couponId));
    const coupon = coupons.get(couponId)!;
    const buildOnly = isBuildOnly(coupon, context.buildProductId);
    const expiry = promo.expires_at ?? coupon.redeem_by;
    rows.push({
      id: promo.id,
      code: promo.code,
      terms: buildOnly ? buildTerms(coupon) : couponTerms(coupon),
      buildOnly,
      expiresAt: expiry ? new Date(expiry * 1000) : null,
      maxRedemptions: promo.max_redemptions,
      timesRedeemed: promo.times_redeemed,
      forOneCustomer: Boolean(promo.customer),
    });
  }

  return rows;
}

/** Switch a code off. Stripe never deletes one; an inactive code just stops working. */
export async function deactivateBuildPromo(id: string): Promise<void> {
  await requireStripe().promotionCodes.update(id, { active: false });
}
