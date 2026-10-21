/**
 * The ids the local cart preview shares between its seed
 * (`seed-cart-preview.ts`) and its Stripe stand-in (`fake-stripe.ts`), so a
 * client seeded as paying by card has a subscription the stand-in knows.
 */

export const PREVIEW = {
  buildProduct: "prod_preview_website_build",
  paying: {
    customer: "cus_preview_sagebrush",
    subscription: "sub_preview_sagebrush",
    planItem: "si_preview_plan",
    addOnItem: "si_preview_leads",
    planKey: "lite",
    addOnKey: "leads",
  },
  /** How far into the future the paying client's period ends. */
  periodDays: 20,
} as const;

/** The paying client's period end, to the hour, so seed and stand-in agree on the date. */
export function previewPeriodEnd(): Date {
  const end = new Date(Date.now() + PREVIEW.periodDays * 86_400_000);
  end.setUTCMinutes(0, 0, 0);
  return end;
}
