/**
 * The site-wide promo banner. Null means no banner, which is the default.
 *
 * To run a promo: make the coupon and its code in Stripe first (the portal
 * applies it at checkout — see docs/stripe-setup.md), then fill this in and
 * deploy. The banner hides itself after `endsOn` even if nobody redeploys:
 * the build leaves it out once the date has passed, and a visitor's browser
 * removes it on a page built before then.
 *
 * The prices on the pricing page do not change. A promo is an offer on top of
 * them, so the published numbers stay what a client returns to afterwards.
 *
 * Example:
 *
 *   export const PROMO: SitePromo | null = {
 *     headline: "Spring offer: half off your first three months of care.",
 *     code: "SPRING50",
 *     endsOn: "2027-04-30",
 *     href: "/contact/",
 *     linkLabel: "Start a project",
 *   };
 */

export interface SitePromo {
  /** One sentence. What the offer is, in the client's terms. */
  headline: string;
  /** The Stripe promotion code to type at checkout, if there is one. */
  code?: string;
  /** Last day the offer runs, `YYYY-MM-DD`, inclusive. */
  endsOn: string;
  /** Where the banner's link goes. Defaults to the contact page. */
  href?: string;
  linkLabel?: string;
}

export const PROMO: SitePromo | null = null;
