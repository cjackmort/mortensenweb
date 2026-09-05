/**
 * The care plans, as sold.
 *
 * One definition for both the public site's pricing page and the portal's
 * `service_plans` seed. Before this package existed the site carried its own
 * copy of these numbers and drifted: on 2026-09-02 the portal moved to
 * $50 / $100 / $200 / $300 with analytics on every tier, and the site went on
 * quoting $49 / $99 / $199 with analytics on two of them. A prospect who
 * signed from the site was quoted one thing and billed another.
 *
 * `monthlyCents` and `overagePerChangeCents` are what a NEW subscription is
 * offered; an existing subscription locks its price at signup (see
 * `subscriptions.monthly_price_cents` in the portal). Change a number here
 * and both the site and the next seed change together.
 *
 * `comp-unlimited` is deliberately absent: it exists to be granted by an
 * operator, never sold, and listing it anywhere public would advertise a free
 * unlimited tier.
 */

export type PlanKey = "care-lite" | "care-basic" | "care-plus" | "care-unlimited";

export interface Plan {
  key: PlanKey;
  name: string;
  /** Short name for tight layouts: "Lite", "Basic". */
  short: string;
  monthlyCents: number;
  /** Null means unlimited. */
  includedChangesPerMonth: number | null;
  /** Null when there is no overage because changes are unlimited. */
  overagePerChangeCents: number | null;
  includesAnalytics: boolean;
  /** One line under the name on the pricing page and the portal. */
  description: string;
  /** Who it is for, in the client's terms. */
  bestFor: string;
  /** Bullet list on the pricing page. First line is the plan's headline. */
  features: string[];
  /** Exactly one plan carries this. */
  featured?: boolean;
  /** Portal sort order. */
  sortOrder: number;
}

export const PLANS: Plan[] = [
  {
    key: "care-lite",
    name: "Care — Lite",
    short: "Lite",
    monthlyCents: 5000,
    includedChangesPerMonth: 1,
    overagePerChangeCents: 2500,
    includesAnalytics: true,
    description: "Hosting, security updates, analytics, and one change a month.",
    bestFor: "A site that is finished and mostly stays that way.",
    features: [
      "One content change a month",
      "Hosting, SSL, and domain configuration",
      "Security and dependency updates",
      "Visitor analytics in your portal",
      "Additional changes $25 each",
    ],
    sortOrder: 10,
  },
  {
    key: "care-basic",
    name: "Care — Basic",
    short: "Basic",
    monthlyCents: 10000,
    includedChangesPerMonth: 5,
    overagePerChangeCents: 2500,
    includesAnalytics: true,
    description: "Hosting, security updates, analytics, and five changes a month.",
    bestFor: "The common choice — enough changes to keep a site current.",
    features: [
      "Five content changes a month",
      "Everything in Lite",
      "Which photos people open and how many get in touch",
      "Priority email support",
      "Additional changes $25 each",
    ],
    featured: true,
    sortOrder: 20,
  },
  {
    key: "care-plus",
    name: "Care — Plus",
    short: "Plus",
    monthlyCents: 20000,
    includedChangesPerMonth: 15,
    overagePerChangeCents: 2500,
    includesAnalytics: true,
    description: "Hosting, security updates, analytics, and fifteen changes a month.",
    bestFor: "A site that earns its keep — menus, listings, a schedule that moves.",
    features: [
      "Fifteen content changes a month",
      "Everything in Basic",
      "Priority turnaround on requests",
      "Quarterly review of how the site is doing",
      "Additional changes $25 each",
    ],
    sortOrder: 30,
  },
  {
    key: "care-unlimited",
    name: "Care — Unlimited",
    short: "Unlimited",
    monthlyCents: 30000,
    includedChangesPerMonth: null,
    overagePerChangeCents: null,
    includesAnalytics: true,
    description: "Hosting, security updates, analytics, and unlimited changes.",
    bestFor: "A business that treats its website like a shopfront and changes it like one.",
    features: [
      "Unlimited content changes",
      "Everything in Plus",
      "No overage, ever",
    ],
    sortOrder: 40,
  },
];

/** The flat overage, for copy that states it once. */
export const OVERAGE_CENTS = 2500;

export function dollars(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

export const CHEAPEST_PLAN = PLANS.reduce((low, p) => (p.monthlyCents < low.monthlyCents ? p : low));
