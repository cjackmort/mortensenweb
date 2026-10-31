import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import type { Database } from "@/db/client";
import { auditLog, clients } from "@/db/schema";
import { requireStripe, stripeConfigured } from "@/lib/payments/stripe";
import { buildInvoicePublicId } from "../build-standing";

/**
 * Closing Stripe checkouts that would take money for something already
 * settled.
 *
 * A checkout page stays payable for a day after it is opened. When an
 * operator marks the invoice behind it paid — cash, a check — or cancels it,
 * that page was still open: the client could pay it, Stripe would take the
 * money, and the receiver would find an invoice already paid or cancelled and
 * send it to review instead of the ledger. Expiring the session is what
 * Stripe offers for exactly this.
 *
 * Two kinds of session, because the build can be paid from either:
 *
 * - **The invoice's own**, the session id `beginStripePayment` keeps on it.
 * - **Every open checkout that would charge for the build**, once the build is
 *   paid by any route: the welcome checkout's subscription session with the
 *   build in its basket, and the build invoice's payment session. A client who
 *   opened one, went back and paid through the other must not be able to pay
 *   for the site twice.
 *
 * Never throws. The caller has already recorded something true — money
 * arrived, or nobody owes this — and a Stripe outage must not undo it or
 * leave a webhook redelivering it. A session that could not be expired is
 * logged and written to the audit log for the operator.
 */

export interface ExpireInput {
  clientId: string;
  organizationId: string;
  /** Session ids to expire if still open: the invoice's own. Anything not a Checkout id is ignored. */
  sessionIds?: (string | null)[];
  /** Also expire every open checkout that would charge for the build. */
  includeBuild?: boolean;
  /** Why, for the audit row. */
  reason: string;
  actorUserId?: string | null;
}

const OPEN_LIMIT = 20;

function chargesForBuild(session: Stripe.Checkout.Session, buildInvoiceId: string): boolean {
  if (session.metadata?.payment_request_id === buildInvoiceId) return true;
  // `build:50000` in the welcome basket's signature; `build:0` means no build.
  return session.metadata?.source === "welcome" && /(^|\|)build:[1-9]/.test(session.metadata?.welcome_basket ?? "");
}

async function openBuildSessions(db: Database, clientId: string): Promise<Stripe.Checkout.Session[]> {
  const [client] = await db
    .select({ customerId: clients.stripeCustomerId })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client?.customerId) return [];
  const buildInvoiceId = await buildInvoicePublicId(clientId);
  const open = await requireStripe().checkout.sessions.list({ customer: client.customerId, status: "open", limit: OPEN_LIMIT });
  return open.data.filter((session) => chargesForBuild(session, buildInvoiceId));
}

export async function expireOpenCheckouts(db: Database, input: ExpireInput): Promise<{ expired: string[]; failed: string[] }> {
  const expired: string[] = [];
  const failed: string[] = [];
  if (!stripeConfigured()) return { expired, failed };

  const stripe = requireStripe();
  const candidates = new Set((input.sessionIds ?? []).filter((id): id is string => Boolean(id?.startsWith("cs_"))));

  try {
    if (input.includeBuild) {
      for (const session of await openBuildSessions(db, input.clientId)) candidates.add(session.id);
    }
  } catch (error) {
    console.error("[stripe:expire] could not list open checkouts", {
      clientId: input.clientId,
      message: error instanceof Error ? error.message : "unknown",
    });
    failed.push("list");
  }

  for (const id of candidates) {
    try {
      const session = await stripe.checkout.sessions.retrieve(id);
      if (session.status !== "open") continue;
      await stripe.checkout.sessions.expire(id);
      expired.push(id);
    } catch (error) {
      console.error("[stripe:expire] could not expire checkout", {
        sessionId: id,
        message: error instanceof Error ? error.message : "unknown",
      });
      failed.push(id);
    }
  }

  if (expired.length > 0 || failed.length > 0) {
    const [client] = await db
      .select({ publicId: clients.publicId })
      .from(clients)
      .where(eq(clients.id, input.clientId))
      .limit(1);
    await db.insert(auditLog).values({
      actorUserId: input.actorUserId ?? null,
      organizationId: input.organizationId,
      action: failed.length > 0 ? "checkout.expire_failed" : "checkout.expired",
      entityType: "client",
      entityId: client?.publicId ?? null,
      metadata: { reason: input.reason, expired, failed, needsOperatorReview: failed.length > 0 },
    });
  }
  return { expired, failed };
}
