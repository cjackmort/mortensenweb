/**
 * The cart a new client pays from: their website build, an optional plan and
 * optional Growth add-ons, as one payment.
 *
 * Pure on purpose. The browser imports this to keep the total live as boxes
 * are ticked, and the server imports the same code to decide what Stripe is
 * asked to charge, so the figure on screen and the figure charged come from
 * one place. Nothing here trusts an amount: the catalogue is built on the
 * server from `@mortensenweb/plans` and the client's own record, and a
 * selection only ever names keys.
 */

export interface CartBuild {
  key: string;
  name: string;
  includes: string[];
  /** The list price, or the price the operator quoted this client. */
  priceCents: number;
}

export interface CartPlan {
  key: string;
  name: string;
  short: string;
  monthlyCents: number;
  description: string;
  features: string[];
  /** The Growth features this plan includes, which are never sold beside it. */
  includes: string[];
  /** The plan an operator assigned this client. */
  recommended: boolean;
  featured: boolean;
}

export interface CartAddOn {
  key: string;
  name: string;
  summary: string;
  monthlyCents: number;
}

export interface CartCatalog {
  build: CartBuild;
  plans: CartPlan[];
  addOns: CartAddOn[];
  /** The operator's billing day, when one was set; the first month is prorated to it. */
  anchorDay: number | null;
}

export interface CartSelection {
  planKey: string | null;
  addOnKeys: string[];
}

export type SelectionResult =
  | { ok: true; selection: CartSelection }
  | { ok: false; message: string };

/**
 * A selection from the form, checked against what this client was offered.
 *
 * An add-on the chosen plan already includes is dropped rather than refused:
 * the form hides those boxes, and dropping one can only lower the charge.
 *
 * Add-ons need a plan. They are sold "on top of any plan", and a subscription
 * of add-ons alone has no plan line for the mirror to read, so it would take
 * an add-on for the plan (`planItemOf`).
 */
export function selectionFrom(
  catalog: CartCatalog,
  raw: { planKey?: string | null; addOnKeys?: string[] },
): SelectionResult {
  const planKey = raw.planKey ? raw.planKey : null;
  const plan = planKey ? catalog.plans.find((p) => p.key === planKey) : null;
  if (planKey && !plan) return { ok: false, message: "That plan isn't available. Pick one of the plans shown." };
  if (!plan && (raw.addOnKeys ?? []).length > 0) {
    return { ok: false, message: "Growth add-ons go on top of a plan. Choose a plan first." };
  }

  const addOnKeys: string[] = [];
  for (const key of raw.addOnKeys ?? []) {
    if (!catalog.addOns.some((a) => a.key === key)) {
      return { ok: false, message: "That add-on isn't available. Pick from the ones shown." };
    }
    if (plan?.includes.includes(key) || addOnKeys.includes(key)) continue;
    addOnKeys.push(key);
  }

  return { ok: true, selection: { planKey, addOnKeys } };
}

/**
 * The next time the billing day comes round, at the same time of day — where
 * Stripe puts a `billing_cycle_anchor_config.day_of_month` anchor. Strictly
 * after `now`; the caller never anchors on today (see `anchorDayFor`).
 */
export function nextAnchorDate(now: Date, day: number): Date {
  const next = new Date(now);
  next.setUTCDate(day);
  if (next.getTime() <= now.getTime()) next.setUTCMonth(next.getUTCMonth() + 1, day);
  return next;
}

/** One calendar month after `date`, which is when an unanchored subscription renews. */
function monthAfter(date: Date): Date {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

/**
 * The first payment for the recurring lines.
 *
 * Without an anchor it is one full month. With one, Stripe prorates each line
 * by the share of the month that ends on the anchor still to run, and rounds
 * each line on its own, so this does the same.
 */
export function firstPeriodCents(monthly: number[], now: Date, anchor: Date | null): number {
  if (!anchor) return monthly.reduce((sum, cents) => sum + cents, 0);
  const periodStart = new Date(anchor);
  periodStart.setUTCMonth(periodStart.getUTCMonth() - 1);
  const share = (anchor.getTime() - now.getTime()) / (anchor.getTime() - periodStart.getTime());
  return monthly.reduce((sum, cents) => sum + Math.round(cents * share), 0);
}

export interface CartLine {
  kind: "build" | "plan" | "add-on";
  key: string;
  name: string;
  /** What this line costs: the build after any promo, or a monthly price. */
  cents: number;
  /** The build before the promo; equal to `cents` everywhere else. */
  listCents: number;
  recurring: boolean;
}

export interface CartQuote {
  lines: CartLine[];
  /** The plan and add-ons, per month, from the second payment on. */
  monthlyCents: number;
  /** The plan and add-ons' share of today's payment. */
  firstPeriodCents: number;
  dueTodayCents: number;
  /** When the next monthly payment is taken; null with nothing recurring. */
  renewsOn: Date | null;
  /** Whether the first month is a part month, up to the billing day. */
  prorated: boolean;
}

/**
 * What a selection costs. `buildDueCents` is the build after any promo, which
 * the server works out from the promo it verified with Stripe.
 */
export function quoteCart(
  catalog: CartCatalog,
  selection: CartSelection,
  buildDueCents: number,
  now: Date = new Date(),
): CartQuote {
  const lines: CartLine[] = [
    {
      kind: "build",
      key: catalog.build.key,
      name: catalog.build.name,
      cents: buildDueCents,
      listCents: catalog.build.priceCents,
      recurring: false,
    },
  ];

  const plan = selection.planKey ? catalog.plans.find((p) => p.key === selection.planKey) : null;
  if (plan) {
    lines.push({ kind: "plan", key: plan.key, name: plan.name, cents: plan.monthlyCents, listCents: plan.monthlyCents, recurring: true });
  }
  for (const key of selection.addOnKeys) {
    const addOn = catalog.addOns.find((a) => a.key === key);
    if (!addOn) continue;
    lines.push({ kind: "add-on", key, name: addOn.name, cents: addOn.monthlyCents, listCents: addOn.monthlyCents, recurring: true });
  }

  const monthly = lines.filter((l) => l.recurring).map((l) => l.cents);
  const monthlyCents = monthly.reduce((sum, cents) => sum + cents, 0);
  const anchor = monthlyCents > 0 && catalog.anchorDay ? nextAnchorDate(now, catalog.anchorDay) : null;
  const first = firstPeriodCents(monthly, now, anchor);

  return {
    lines,
    monthlyCents,
    firstPeriodCents: first,
    dueTodayCents: buildDueCents + first,
    renewsOn: monthlyCents === 0 ? null : (anchor ?? monthAfter(now)),
    prorated: anchor !== null,
  };
}

/** "$500", "$17.74": whole dollars when there are no cents, as on the plan cards. */
export function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}
