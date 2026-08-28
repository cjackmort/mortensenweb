/**
 * Care plans, as advertised.
 *
 * These mirror the `service_plans` rows seeded in
 * `apps/platform/scripts/seed.ts`. They are duplicated rather than fetched
 * because this site is a static export with no database connection — but that
 * makes them a copy, and a copy drifts. **If a price changes in the portal,
 * change it here in the same commit.**
 *
 * `comp-unlimited` is deliberately absent. It exists to be granted by an
 * operator, not bought, and the seed file sorts it last specifically so it is
 * never pitched. Listing it here would advertise a free unlimited tier.
 */

export type Plan = {
  key: string;
  name: string;
  /** Whole dollars per month. */
  monthly: number;
  description: string;
  /** Cost of a change beyond the monthly allowance, in whole dollars. */
  overage: number;
  changesPerMonth: number;
  analytics: boolean;
  features: string[];
  /** Exactly one plan should carry this. */
  featured?: boolean;
};

export const PLANS: Plan[] = [
  {
    key: "care-lite",
    name: "Care — Lite",
    monthly: 49,
    description:
      "For a site that is finished and mostly stays that way. Hosting and security handled; the occasional change included.",
    overage: 49,
    changesPerMonth: 1,
    analytics: false,
    features: [
      "Hosting, SSL, and domain configuration",
      "Security and dependency updates",
      "One content change a month",
      "Additional changes $49 each",
      "Email support",
    ],
  },
  {
    key: "care-basic",
    name: "Care — Basic",
    monthly: 99,
    description:
      "The common choice. Enough changes to keep a site current, plus the traffic numbers to know whether it is working.",
    overage: 39,
    changesPerMonth: 3,
    analytics: true,
    features: [
      "Everything in Lite",
      "Three content changes a month",
      "Additional changes $39 each",
      "Visitor analytics in your portal",
      "Priority email support",
    ],
    featured: true,
  },
  {
    key: "care-plus",
    name: "Care — Plus",
    monthly: 199,
    description:
      "For a site that earns its keep — seasonal menus, new listings, a schedule that actually changes week to week.",
    overage: 29,
    changesPerMonth: 10,
    analytics: true,
    features: [
      "Everything in Basic",
      "Ten content changes a month",
      "Additional changes $29 each",
      "Priority turnaround on requests",
      "Quarterly review of the site's performance",
    ],
  },
];
