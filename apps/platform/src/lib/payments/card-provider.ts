import { isSquareConfigured } from "./square";
import { stripeConfigured } from "./stripe";

export type CardProvider = "stripe" | "square";

/**
 * Which processor takes a one-off card payment in this environment, if any.
 *
 * Stripe when it has a key, because it is also the processor holding
 * subscriptions — a client should meet one card processor, not one for the
 * monthly charge and another for an extra change. Square remains the fallback
 * so an environment configured only for Square keeps working unchanged.
 */
export function cardProvider(): CardProvider | null {
  if (stripeConfigured()) return "stripe";
  if (isSquareConfigured()) return "square";
  return null;
}
