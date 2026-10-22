import type { Database } from "@/db/client";
import type { ResendEvent } from "@/lib/email/resend-webhook";
import { FEATURE_TAG } from "@/lib/email/tags";
import { applyReviewDeliveryEvent } from "./reviews";
import { applyWinbackEvent } from "./winback";

/**
 * What happened to an email after it left, handed to the feature that sent it.
 *
 * `/api/webhooks/resend` verifies a delivery, parses it, and calls
 * `routeDeliveryEvent`. Which feature an event belongs to comes from the
 * `feature` tag the sender put on the email (`lib/email/tags.ts`); the handler
 * registered for that feature decides what to record — and, for a bounce or a
 * complaint, which suppression list the address goes on. Every feature that
 * sends to customers in bulk keeps its own list, because "stop sending me
 * offers" from one business says nothing about another business's mail.
 *
 * ## Registering a feature
 *
 * Tag the outgoing mail with `featureTags("<key>", organizationId, …)`, write
 * a `DeliveryEventHandler`, and add one line to `DELIVERY_EVENT_HANDLERS`.
 * A static map rather than a `register()` call: a route only sees the modules
 * it imports, so a handler registered as a side effect of some other module
 * loading would silently be missing from the webhook's function.
 *
 * A handler must be idempotent (Resend retries, and sends opens repeatedly),
 * must check that the organization tag matches the row it finds, and should
 * throw only for a failure worth a retry — the route answers 500 on a throw,
 * and Resend tries again.
 */

export type DeliveryEventHandler = (db: Database, event: ResendEvent) => Promise<void>;

export const DELIVERY_EVENT_HANDLERS: Record<string, DeliveryEventHandler> = {
  winback: applyWinbackEvent,
  reviews: applyReviewDeliveryEvent,
};

export async function routeDeliveryEvent(db: Database, event: ResendEvent): Promise<"handled" | "unrouted"> {
  const feature = event.tags[FEATURE_TAG];
  const handler = feature ? DELIVERY_EVENT_HANDLERS[feature] : undefined;
  if (!handler) return "unrouted";
  await handler(db, event);
  return "handled";
}
