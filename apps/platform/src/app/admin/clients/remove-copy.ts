import type { ArchiveClientOutcome } from "@/db/repositories/admin/clients";

/**
 * What to tell the operator when a client cannot be removed.
 *
 * Its own module because the page shows the Stripe reason up front, in place of
 * the button, while the action returns it as a backstop — and a "use server"
 * file may export only async functions, so the text cannot live there.
 */

export const STRIPE_BILLING_BLOCK =
  "They have an active Stripe subscription, so they are still being billed. Cancel it in Stripe first (Dashboard → Subscriptions), then remove them here.";

export const REMOVE_REFUSALS: Record<
  Extract<ArchiveClientOutcome, { ok: false }>["reason"],
  string
> = {
  not_found: "That client no longer exists.",
  already_archived: "That client has already been removed.",
  internal: "This is the agency's own site, so it can't be removed.",
  active_subscription: STRIPE_BILLING_BLOCK,
};
