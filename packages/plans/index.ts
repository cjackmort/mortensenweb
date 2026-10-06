/**
 * The plans, the Growth features and the builds, as sold.
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
 * ## The 2026-10-06 lineup
 *
 * Four plans that climb by what they *do* for the business, not by a change
 * count: Lite is a hosted site with a change a month; Care adds unlimited
 * changes and the leads inbox; Growth and Pro add the Growth tab's tools.
 * Every Growth feature can also be bought on its own (`addOnCents`), and the
 * add-on prices are set so that upgrading to Growth or Pro is always cheaper
 * than assembling it from add-ons — see `upgradeBeatsAddOns` below, which a
 * test holds this file to.
 *
 * The old keys (`care-lite` … `care-unlimited`) are gone from here but not
 * from the database: their subscribers were moved onto the new plans at their
 * existing price, and their Stripe prices are still recognised. See
 * `0026_plans_2026_10.sql` and `LEGACY_LOOKUP_KEYS` in the portal.
 *
 * `comp-unlimited` is deliberately absent: it exists to be granted by an
 * operator, never sold, and listing it anywhere public would advertise a free
 * unlimited tier.
 */

export type PlanKey = "lite" | "care" | "growth" | "pro";

// ---------------------------------------------------------------------------
// Growth features
// ---------------------------------------------------------------------------

export type GrowthFeatureKey =
  | "leads"
  | "campaigns"
  | "reviews"
  | "winback"
  | "showcase"
  | "google-profile";

export interface GrowthFeature {
  key: GrowthFeatureKey;
  name: string;
  /** What it does, in one line. */
  summary: string;
  /** What it does *for the business*, in one line — the reason to want it. */
  benefit: string;
  /** Monthly price when bought on its own, on top of any plan. */
  addOnCents: number;
  /** The cheapest plan that includes it. */
  includedFrom: PlanKey;
  /**
   * Whether it exists yet. A feature that is not built is shown as "coming
   * soon" and is never sold on its own: charging for a button that does
   * nothing is the one thing a locked card must not do.
   */
  available: boolean;
}

export const GROWTH_FEATURES: GrowthFeature[] = [
  {
    key: "leads",
    name: "Leads inbox",
    summary: "Every contact-form enquiry in your portal, and reply to customers from there.",
    benefit: "No enquiry gets lost in an inbox, and you answer faster than the next quote they asked for.",
    addOnCents: 1500,
    includedFrom: "care",
    available: true,
  },
  {
    key: "campaigns",
    name: "QR & campaign tracking",
    summary: "Trackable QR codes and links for door hangers, flyers, yard signs and trucks.",
    benefit: "Know which print campaign actually brought in calls — and stop paying for the ones that don't.",
    addOnCents: 2000,
    includedFrom: "growth",
    available: false,
  },
  {
    key: "reviews",
    name: "Review requests",
    summary: "Ask your customers for a Google review in one click, with a reminder if they forget.",
    benefit: "More recent reviews push you up the Google map, where most local calls come from.",
    addOnCents: 3500,
    includedFrom: "growth",
    available: false,
  },
  {
    key: "winback",
    name: "Win-back emails",
    summary: "Seasonal reminders and offers to your past customers, written for you to approve.",
    benefit: "Repeat work from people who already trust you — the cheapest job you will ever win.",
    addOnCents: 2500,
    includedFrom: "pro",
    available: false,
  },
  {
    key: "showcase",
    name: "Job showcase",
    summary: "Photos of a finished job become a page on your site, a Google post and social graphics.",
    benefit: "Show your real work everywhere customers look, without writing a word.",
    addOnCents: 4000,
    includedFrom: "pro",
    available: false,
  },
  {
    key: "google-profile",
    name: "Google profile management",
    summary: "We keep your Google Business Profile current: posts, hours, photos and review replies.",
    benefit: "An active, accurate profile ranks higher on Google Maps and turns more searches into calls.",
    addOnCents: 6500,
    includedFrom: "pro",
    available: false,
  },
];

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export interface Plan {
  key: PlanKey;
  name: string;
  /** Short name for tight layouts. */
  short: string;
  monthlyCents: number;
  /** Null means unlimited. */
  includedChangesPerMonth: number | null;
  /** Null when there is no overage because changes are unlimited. */
  overagePerChangeCents: number | null;
  includesAnalytics: boolean;
  /** The Growth features this plan includes. Derived from `includedFrom`. */
  growthFeatures: GrowthFeatureKey[];
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

const PLAN_ORDER: PlanKey[] = ["lite", "care", "growth", "pro"];

/** Whether `plan` is `from` or a plan above it. */
export function planIncludes(plan: PlanKey, from: PlanKey): boolean {
  return PLAN_ORDER.indexOf(plan) >= PLAN_ORDER.indexOf(from);
}

function featuresFor(plan: PlanKey): GrowthFeatureKey[] {
  return GROWTH_FEATURES.filter((f) => planIncludes(plan, f.includedFrom)).map((f) => f.key);
}

/** "Review requests (coming soon)" — so the pricing page never sells what is not built. */
function featureLine(key: GrowthFeatureKey): string {
  const feature = GROWTH_FEATURES.find((f) => f.key === key)!;
  return feature.available ? feature.name : `${feature.name} (coming soon)`;
}

export const PLANS: Plan[] = [
  {
    key: "lite",
    name: "Lite",
    short: "Lite",
    monthlyCents: 2500,
    includedChangesPerMonth: 1,
    overagePerChangeCents: 2500,
    includesAnalytics: true,
    growthFeatures: featuresFor("lite"),
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
    key: "care",
    name: "Care",
    short: "Care",
    monthlyCents: 5000,
    includedChangesPerMonth: null,
    overagePerChangeCents: null,
    includesAnalytics: true,
    growthFeatures: featuresFor("care"),
    description: "Unlimited changes, plus every website enquiry in your portal.",
    bestFor: "A business that keeps its site current and wants every enquiry in one place.",
    features: [
      "Unlimited content changes, one at a time",
      "Everything in Lite",
      "Leads inbox — reply to enquiries from your portal",
      "Monthly report: visitors, calls and enquiries (coming soon)",
    ],
    featured: true,
    sortOrder: 20,
  },
  {
    key: "growth",
    name: "Growth",
    short: "Growth",
    monthlyCents: 10000,
    includedChangesPerMonth: null,
    overagePerChangeCents: null,
    includesAnalytics: true,
    growthFeatures: featuresFor("growth"),
    description: "Tools that bring in more customers: reviews and trackable campaigns.",
    bestFor: "A business ready to grow its Google reviews and see which marketing works.",
    features: [
      "Everything in Care",
      featureLine("reviews"),
      featureLine("campaigns"),
    ],
    sortOrder: 30,
  },
  {
    key: "pro",
    name: "Pro",
    short: "Pro",
    monthlyCents: 15000,
    includedChangesPerMonth: null,
    overagePerChangeCents: null,
    includesAnalytics: true,
    growthFeatures: featuresFor("pro"),
    description: "Every Growth feature, including your Google profile managed for you.",
    bestFor: "A business that wants its whole online presence handled.",
    features: [
      "Everything in Growth",
      featureLine("google-profile"),
      featureLine("showcase"),
      featureLine("winback"),
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

/**
 * What a client on `current` would pay each month to get `target`'s Growth
 * features as add-ons instead of upgrading — and how much upgrading saves.
 *
 * The rule the add-on prices are set by: from any plan to Growth or Pro,
 * assembling the higher plan from add-ons costs more than moving up. Lite to
 * Care is the one step where add-ons come out cheaper ($25 + $15 leads inbox
 * against $50), and deliberately so: what Care sells is unlimited changes,
 * which are never an add-on — the upgrade is the only way to them.
 */
export function upgradeBeatsAddOns(current: PlanKey, target: PlanKey): {
  addOnTotalCents: number;
  upgradeCents: number;
  saves: number;
} {
  const from = PLANS.find((p) => p.key === current)!;
  const to = PLANS.find((p) => p.key === target)!;
  const missing = to.growthFeatures.filter((key) => !from.growthFeatures.includes(key));
  const addOnTotalCents =
    from.monthlyCents +
    missing.reduce((sum, key) => sum + GROWTH_FEATURES.find((f) => f.key === key)!.addOnCents, 0);
  return {
    addOnTotalCents,
    upgradeCents: to.monthlyCents,
    saves: addOnTotalCents - to.monthlyCents,
  };
}

// ---------------------------------------------------------------------------
// Builds
// ---------------------------------------------------------------------------

/**
 * The build, priced by where the business is — decided 2026-10-06.
 *
 * Replaces the single $1,200 build with a $500 discounted price behind a
 * twelve-month commitment. These stand alone: no plan required, no minimum
 * term, nothing clawed back. A build without a plan is handed over at launch
 * — hosting on the client's own Netlify account — so an unpaid site never
 * draws on the agency's shared allowance.
 *
 * The tier is the operator's judgement at intake, not a calculation: whether
 * a business is "established" is not something a form can measure.
 */
export type BuildKey = "launch" | "revamp" | "established";

export interface Build {
  key: BuildKey;
  name: string;
  priceCents: number;
  /** Who it is for, in the client's terms. */
  who: string;
  /** `who` in a few words, for a dropdown option. */
  short: string;
  includes: string[];
}

export const BUILDS: Build[] = [
  {
    key: "launch",
    name: "Launch",
    priceCents: 10000,
    who: "Just starting out — no website yet, little or no presence online.",
    short: "just starting out",
    includes: [
      "A finished site, launched on your domain",
      "Up to five pages, written with you",
      "Two rounds of revisions before launch",
    ],
  },
  {
    key: "revamp",
    name: "Revamp",
    priceCents: 50000,
    who: "You have a website that people already visit, and it's time for a better one.",
    short: "replacing a site people already visit",
    includes: [
      "Everything in Launch",
      "Your existing content moved across",
      "Redirects from every old page, so you keep your Google rankings",
    ],
  },
  {
    key: "established",
    name: "Established",
    priceCents: 100000,
    who: "A well-known business with years of content and search rankings to protect.",
    short: "a well-established business",
    includes: [
      "Everything in Revamp",
      "A larger site, planned page by page",
      "A full search audit before and after launch",
    ],
  },
];

export const CHEAPEST_BUILD = BUILDS.reduce((low, b) => (b.priceCents < low.priceCents ? b : low));
