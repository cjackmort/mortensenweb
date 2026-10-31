import {
  BUILD,
  GROWTH_FEATURES,
  PLANS,
  isFree,
  planIncludes,
  type GrowthFeature,
  type GrowthFeatureKey,
  type PlanKey,
} from "@mortensenweb/plans";

/**
 * The welcome checkout's basket: what a new client pays on their first
 * visit, built from what they chose and what they owe — nothing else.
 *
 * Pure, and imported by both sides: the page uses it to show the total as
 * the client ticks boxes, and the server uses it to decide what Stripe is
 * asked to charge. One function means the total on screen and the lines on
 * Stripe's page cannot be worked out two different ways.
 *
 * ## What goes in, and how it is charged
 *
 * - **The site.** The published build price (`BUILD`), only while the build
 *   is unpaid and nothing is invoiced. An invoice an operator raised is
 *   never folded in here: it has its own reference, its own settlement and
 *   its own pay button, and paying it twice — once here, once on Billing —
 *   is the mistake this keeps impossible.
 * - **A care plan**, optional, at the price `@mortensenweb/plans` quotes.
 * - **Growth add-ons**, optional, on top of a plan — which is how they are
 *   sold everywhere else (see `addGrowthAddOn`). One the chosen plan already
 *   includes, or a free one, is dropped rather than charged for twice.
 *
 * Anything that repeats makes the checkout a subscription, and the build
 * rides on its first payment as a one-time line. With nothing repeating it
 * is a single payment.
 *
 * The amounts here are what the client is quoted. What Stripe charges is its
 * own price for each lookup key; the two are kept equal by `stripe-setup`,
 * and Stripe's page is where the client authorises the real figure.
 */

export type SiteDue =
  /** Nothing to pay for the site: paid already, on the house, or the agency's own. */
  | { kind: "none"; reason: "paid" | "complimentary" | "internal" | "waived" }
  /** Never paid and nothing invoiced: the published build price. */
  | { kind: "build"; amountCents: number }
  /** An invoice is open for them. Paid on its own, through the Billing flow. */
  | {
      kind: "invoice";
      publicId: string;
      reference: string;
      amountCents: number;
      currency: string;
      note: string | null;
      dueOn: string | null;
      status: "open" | "overdue" | "awaiting_confirmation";
      /** Further open invoices after this one, which Billing lists. */
      others: number;
    };

/** A plan this client may choose, at the price they are quoted. */
export interface OfferedPlan {
  key: string;
  name: string;
  monthlyCents: number;
}

export type AddOnState =
  /** Every client has it, plan or not. */
  | { kind: "free" }
  /** The chosen plan includes it. */
  | { kind: "included"; planName: string }
  /** Not built yet: shown, never sold. */
  | { kind: "coming_soon" }
  /** Sold on top of a plan, and no plan is chosen. */
  | { kind: "needs_plan"; monthlyCents: number }
  | { kind: "available"; monthlyCents: number };

export interface AddOnOption {
  feature: GrowthFeature;
  state: AddOnState;
}

export interface BasketLine {
  kind: "build" | "plan" | "add-on";
  key: string;
  name: string;
  amountCents: number;
  /** Charged every month rather than once. */
  recurring: boolean;
}

export interface Basket {
  /** A subscription when anything repeats; a single payment otherwise. */
  mode: "subscription" | "payment";
  lines: BasketLine[];
  /** Before any promo, and before a first month is shortened to a payment day. */
  dueTodayCents: number;
  monthlyCents: number;
  planKey: string | null;
  addOns: GrowthFeatureKey[];
  includesBuild: boolean;
}

export type BasketRefusalReason =
  | "unknown_plan"
  | "unknown_add_on"
  | "add_on_unavailable"
  | "add_on_needs_plan";

export type BasketResult =
  /** `basket` is null when there is nothing to pay. */
  | { ok: true; basket: Basket | null }
  | { ok: false; reason: BasketRefusalReason; message: string };

/** The name on the build's line, on our page and on Stripe's. */
export const BUILD_LINE_NAME = `${BUILD.name} build`;

function isPlanKey(value: string | null | undefined): value is PlanKey {
  return PLANS.some((p) => p.key === value);
}

/** Whether the plan includes the feature. A key the package does not know includes nothing. */
function planCovers(planKey: string | null, feature: GrowthFeature): boolean {
  return isPlanKey(planKey) && planIncludes(planKey, feature.includedFrom);
}

function addOnState(feature: GrowthFeature, planKey: string | null): AddOnState {
  if (!feature.available) return { kind: "coming_soon" };
  if (isFree(feature)) return { kind: "free" };
  if (planKey && planCovers(planKey, feature)) {
    return { kind: "included", planName: PLANS.find((p) => p.key === planKey)!.name };
  }
  return planKey
    ? { kind: "available", monthlyCents: feature.addOnCents }
    : { kind: "needs_plan", monthlyCents: feature.addOnCents };
}

const STATE_ORDER: Record<AddOnState["kind"], number> = {
  available: 0,
  needs_plan: 0,
  included: 1,
  free: 2,
  coming_soon: 3,
};

/** Every Growth feature as the welcome page lists it: the ones for sale first. */
export function addOnOptions(planKey: string | null): AddOnOption[] {
  return GROWTH_FEATURES.map((feature) => ({ feature, state: addOnState(feature, planKey) })).sort(
    (a, b) => STATE_ORDER[a.state.kind] - STATE_ORDER[b.state.kind],
  );
}

export function buildWelcomeBasket(input: {
  siteDue: SiteDue;
  plans: readonly OfferedPlan[];
  planKey: string | null;
  addOns: readonly string[];
}): BasketResult {
  const plan = input.planKey ? input.plans.find((p) => p.key === input.planKey) : null;
  if (input.planKey && !plan) {
    return { ok: false, reason: "unknown_plan", message: "That plan is not available. Please choose one of those shown." };
  }

  const addOns: GrowthFeatureKey[] = [];
  for (const key of new Set(input.addOns)) {
    const feature = GROWTH_FEATURES.find((f) => f.key === key);
    if (!feature) {
      return { ok: false, reason: "unknown_add_on", message: "One of those add-ons does not exist. Please reload the page." };
    }
    const state = addOnState(feature, plan?.key ?? null);
    if (state.kind === "coming_soon") {
      return { ok: false, reason: "add_on_unavailable", message: `${feature.name} is not ready yet.` };
    }
    // Already theirs, with this plan or with every site: nothing to charge.
    if (state.kind === "free" || state.kind === "included") continue;
    if (state.kind === "needs_plan") {
      return {
        ok: false,
        reason: "add_on_needs_plan",
        message: "Add-ons go on top of a care plan. Choose a plan, or untick the add-ons.",
      };
    }
    addOns.push(feature.key);
  }

  const lines: BasketLine[] = [];
  if (plan) {
    lines.push({ kind: "plan", key: plan.key, name: `${plan.name} plan`, amountCents: plan.monthlyCents, recurring: true });
  }
  for (const key of addOns) {
    const feature = GROWTH_FEATURES.find((f) => f.key === key)!;
    lines.push({ kind: "add-on", key, name: feature.name, amountCents: feature.addOnCents, recurring: true });
  }
  const includesBuild = input.siteDue.kind === "build";
  if (input.siteDue.kind === "build") {
    lines.push({
      kind: "build",
      key: "build",
      name: BUILD_LINE_NAME,
      amountCents: input.siteDue.amountCents,
      recurring: false,
    });
  }

  if (lines.length === 0) return { ok: true, basket: null };

  const monthlyCents = lines.filter((l) => l.recurring).reduce((sum, l) => sum + l.amountCents, 0);
  return {
    ok: true,
    basket: {
      mode: plan ? "subscription" : "payment",
      lines,
      dueTodayCents: lines.reduce((sum, l) => sum + l.amountCents, 0),
      monthlyCents,
      planKey: plan?.key ?? null,
      addOns,
      includesBuild,
    },
  };
}

/**
 * A higher plan that includes every chosen add-on for less than the chosen
 * plan plus those add-ons — the nudge the Plan tab gives, at the moment of
 * choosing. Null when there is no such plan, or no saving.
 */
export function cheaperPlanFor(
  planKey: string | null,
  addOns: readonly string[],
  offered: readonly OfferedPlan[],
): { planKey: PlanKey; planName: string; savesCents: number } | null {
  if (!isPlanKey(planKey) || addOns.length === 0) return null;
  const current = PLANS.find((p) => p.key === planKey)!;
  const features = GROWTH_FEATURES.filter((f) => addOns.includes(f.key));
  const assembled = current.monthlyCents + features.reduce((sum, f) => sum + f.addOnCents, 0);

  const better = PLANS.filter(
    (p) =>
      p.monthlyCents > current.monthlyCents &&
      p.monthlyCents < assembled &&
      offered.some((o) => o.key === p.key) &&
      features.every((f) => planIncludes(p.key, f.includedFrom)),
  ).sort((a, b) => a.monthlyCents - b.monthlyCents)[0];

  return better ? { planKey: better.key, planName: better.name, savesCents: assembled - better.monthlyCents } : null;
}

/** A Stripe price, by id. Only the id is sent: Stripe holds the amount. */
export interface PriceRef {
  id: string;
}

/** The subset of a Checkout line item this builds. */
export type CheckoutLineItem = { price: string; quantity: 1 };

/**
 * The basket as Stripe Checkout line items.
 *
 * Every line by price id, so Stripe charges the price it holds for each lookup
 * key. The build is the one-off price on the "Website build" product
 * (`lib/payments/build.ts`), which Checkout in subscription mode adds to the
 * first invoice only — a real product rather than an amount, so it can be
 * found on that invoice, reported on, and have a promo code restricted to it.
 * A line whose price is missing refuses the whole basket: leaving it out would
 * quietly charge for less than the client chose, and give them a feature, or a
 * website, nothing pays for.
 */
export function stripeLineItems(
  basket: Basket,
  prices: { plan: PriceRef | null; addOns: Partial<Record<GrowthFeatureKey, PriceRef>>; build: PriceRef | null },
): { ok: true; items: CheckoutLineItem[] } | { ok: false; missing: string } {
  const items: CheckoutLineItem[] = [];
  for (const line of basket.lines) {
    const price =
      line.kind === "build" ? prices.build : line.kind === "plan" ? prices.plan : prices.addOns[line.key as GrowthFeatureKey];
    if (!price) return { ok: false, missing: line.name };
    items.push({ price: price.id, quantity: 1 });
  }
  return { ok: true, items };
}

/**
 * What was chosen, as a short stable string: `plan:care|add:reviews,winback|build:50000`.
 *
 * Stored on the Checkout Session so a second click with the same choice
 * reuses the open session, and one with a different choice does not.
 */
export function basketSignature(basket: Basket): string {
  const build = basket.lines.find((l) => l.kind === "build");
  return [
    `plan:${basket.planKey ?? "none"}`,
    `add:${[...basket.addOns].sort().join(",") || "none"}`,
    `build:${build ? build.amountCents : 0}`,
  ].join("|");
}

/** "$500", "$99.50". Cents only when there are some. */
export function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}
