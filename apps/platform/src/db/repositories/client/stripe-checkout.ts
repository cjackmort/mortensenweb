import { and, eq, isNull } from "drizzle-orm";
import type Stripe from "stripe";
import type { Database } from "@/db/client";
import { clients, organizations, servicePlans, subscriptions } from "@/db/schema";
import { anchorDayFor } from "@/lib/billing/billing-day";
import { PLANS } from "@mortensenweb/plans";
import {
  planForLookupKey,
  priceForPlan,
  requireStripe,
  stripeConfigured,
} from "@/lib/payments/stripe";
import { usablePromo } from "@/lib/payments/promos";
import { type AdminContext, type TenantContext } from "../context";

/**
 * Starting a Stripe subscription for the signed-in client.
 *
 * ## What the browser is allowed to decide
 *
 * Nothing that costs money. The form posts a plan *key* — `care-basic` — and
 * this module resolves it to a price by looking up the plan row and then
 * asking Stripe for the price carrying that lookup key. A price id, an amount,
 * a customer id or an organization id arriving from the browser is ignored
 * wherever it appears, because all four are trivially editable in devtools and
 * three of them decide who gets charged what.
 *
 * The tenant comes from `TenantContext`, which is derived from the session, so
 * a client cannot start a checkout for a different client by any input this
 * function accepts.
 *
 * ## What it refuses
 *
 * A complimentary client, always. `comp_plan_id` means somebody decided this
 * client does not pay; putting them through checkout would charge a person who
 * was promised they would not be charged, and that is not recoverable by a
 * refund because the damage is to the relationship.
 *
 * A client who already has a live Stripe subscription. This is the
 * double-charge guard, and it is checked against Stripe rather than against
 * the local mirror: the mirror can be stale by exactly the window that
 * matters — the seconds between a first checkout completing and its webhook
 * landing.
 */

export type StripeCheckoutOutcome =
  | { ok: true; url: string; sessionId: string; reused: boolean }
  | {
      ok: false;
      reason:
        | "not_configured"
        | "no_client"
        | "unknown_plan"
        | "no_price"
        | "already_subscribed"
        | "complimentary"
        | "stripe_failed";
      message: string;
    };

export interface ResolvedClient {
  clientId: string;
  publicId: string;
  businessName: string;
  contactEmail: string | null;
  stripeCustomerId: string | null;
  compPlanId: string | null;
  /** A promo an operator attached for this checkout. */
  promoCodeId: string | null;
}

const RESOLVED_CLIENT = {
  clientId: clients.id,
  publicId: clients.publicId,
  businessName: organizations.name,
  contactEmail: clients.primaryContactEmail,
  stripeCustomerId: clients.stripeCustomerId,
  compPlanId: clients.compPlanId,
  promoCodeId: clients.promoCodeId,
};

export async function resolveClient(
  db: Database,
  ctx: TenantContext,
): Promise<ResolvedClient | null> {
  const rows = await db
    .select(RESOLVED_CLIENT)
    .from(clients)
    .innerJoin(organizations, eq(organizations.id, clients.organizationId))
    .where(eq(clients.organizationId, ctx.organizationId))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * The plan and payment day an operator assigned, before Stripe takes over.
 *
 * The hand-billed row (no provider) is where that choice lives: see
 * `admin/billing-plan.ts`. Null when nobody has chosen a plan for them yet.
 */
export async function assignedPlanFor(
  db: Database,
  clientId: string,
): Promise<{ planKey: string; billingDay: number } | null> {
  const rows = await db
    .select({ planKey: servicePlans.key, billingDay: subscriptions.billingDay })
    .from(subscriptions)
    .innerJoin(servicePlans, eq(servicePlans.id, subscriptions.planId))
    .where(
      and(
        eq(subscriptions.clientId, clientId),
        eq(subscriptions.status, "active"),
        isNull(subscriptions.provider),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

/**
 * The Stripe customer for this client, created once and remembered.
 *
 * The `metadata` written here is what the webhook receiver matches on when the
 * local row is missing or the customer id has not been stored yet — a real
 * case, because Stripe can deliver `checkout.session.completed` before the
 * function that created the session has finished writing.
 *
 * The write-back is conditional on the column still being null. Two tabs
 * racing here would otherwise each create a customer and the second would
 * overwrite the first, orphaning an invoice history under a customer nothing
 * points at any more.
 */
export async function ensureCustomer(
  db: Database,
  client: ResolvedClient,
): Promise<string> {
  if (client.stripeCustomerId) return client.stripeCustomerId;

  const stripe = requireStripe();

  const customer = await stripe.customers.create(
    {
      name: client.businessName,
      email: client.contactEmail ?? undefined,
      metadata: {
        client_public_id: client.publicId,
        client_id: client.clientId,
        source: "mortensenweb-portal",
      },
    },
    // Keyed on the client, so a retry or a double-submit cannot mint a second
    // customer for the same tenant even if the write-back below never runs.
    { idempotencyKey: `customer:${client.clientId}` },
  );

  const claimed = await db
    .update(clients)
    .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
    .where(
      and(
        eq(clients.id, client.clientId),
        // Only claim if nobody else did first. `isNull` and not `eq(…, null)`:
        // SQL `= NULL` is never true, so the equality form would match no rows
        // and every caller would silently take the lost-the-race path.
        isNull(clients.stripeCustomerId),
      ),
    )
    .returning({ id: clients.id });

  if (claimed.length > 0) return customer.id;

  // Somebody won the race. Use whatever landed, not what we just made — the
  // stored id is the one every other part of the system will match on.
  const current = await db
    .select({ stripeCustomerId: clients.stripeCustomerId })
    .from(clients)
    .where(eq(clients.id, client.clientId))
    .limit(1);

  return current[0]?.stripeCustomerId ?? customer.id;
}

/**
 * Does this customer already have a subscription that bills them?
 *
 * `all` rather than `active`, then filtered, because `past_due` and `unpaid`
 * are still live subscriptions that will charge again — starting a second one
 * for a client whose card merely failed once is exactly the double-billing
 * this guard exists to prevent.
 *
 * `incomplete` is *not* treated as live. That status means a checkout was
 * started and the first payment never completed; those expire on their own and
 * blocking on one would lock a client out of paying after a card was declined.
 */
async function liveSubscription(
  customerId: string,
): Promise<Stripe.Subscription | null> {
  const stripe = requireStripe();
  const found = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 100,
  });

  const live = found.data.find((s) =>
    ["active", "trialing", "past_due", "unpaid", "paused"].includes(s.status),
  );

  return live ?? null;
}

/**
 * An already-open Checkout Session for the same price, if there is one.
 *
 * This is the double-click and multiple-tab guard. Stripe holds the session
 * list, which is what makes it work across tabs, across devices, and across a
 * server restart — a lock or an in-memory set would cover none of those.
 *
 * Reusing the URL rather than refusing is deliberate: a client who clicked
 * twice wants to pay, and the second click should take them to the same
 * checkout, not to an error telling them they already started one.
 */
async function openSessionFor(
  customerId: string,
  priceId: string,
  billingDay: string,
  promoCodeId: string,
): Promise<Stripe.Checkout.Session | null> {
  const stripe = requireStripe();
  const sessions = await stripe.checkout.sessions.list({
    customer: customerId,
    status: "open",
    limit: 20,
    expand: ["data.line_items"],
  });

  const match = sessions.data.find((session) => {
    if (session.mode !== "subscription") return false;
    if (session.expires_at && session.expires_at * 1000 < Date.now()) {
      return false;
    }
    // A checkout made before the operator moved the payment day would start
    // the subscription on the old one.
    if ((session.metadata?.billing_day ?? "") !== billingDay) return false;
    // Nor one made before an operator attached a promo, or removed one: the
    // client would pay a price nobody meant to offer them.
    if ((session.metadata?.promo_code_id ?? "") !== promoCodeId) return false;
    return session.line_items?.data.some((item) => item.price?.id === priceId);
  });

  return match ?? null;
}

export interface BeginStripeCheckoutInput {
  /** A plan key. Never a price id, never an amount — see the module comment. */
  planKey: string;
  /** Where Stripe returns the client. Built server-side by the caller. */
  successUrl: string;
  cancelUrl: string;
}

export async function beginStripeCheckout(
  db: Database,
  ctx: TenantContext,
  input: BeginStripeCheckoutInput,
): Promise<StripeCheckoutOutcome> {
  if (!stripeConfigured()) return NOT_CONFIGURED;

  const client = await resolveClient(db, ctx);
  if (!client) {
    return {
      ok: false,
      reason: "no_client",
      message: "Your account is not linked to a client record.",
    };
  }

  return checkoutFor(db, client, input);
}

/**
 * A checkout for the plan an operator assigned, started from the admin side.
 *
 * The link it returns is what the operator sends the client, or opens
 * themselves to test payments. The plan is the assigned one, never a choice
 * made on this request, so the same rules hold as for the client's own button.
 */
export async function beginCheckoutForClient(
  _ctx: AdminContext,
  db: Database,
  clientPublicId: string,
  urls: Omit<BeginStripeCheckoutInput, "planKey">,
): Promise<StripeCheckoutOutcome> {
  if (!stripeConfigured()) return NOT_CONFIGURED;

  const rows = await db
    .select(RESOLVED_CLIENT)
    .from(clients)
    .innerJoin(organizations, eq(organizations.id, clients.organizationId))
    .where(eq(clients.publicId, clientPublicId))
    .limit(1);
  const client = rows[0];
  if (!client) {
    return { ok: false, reason: "no_client", message: "No such client." };
  }

  const assigned = await assignedPlanFor(db, client.clientId);
  if (!assigned) {
    return {
      ok: false,
      reason: "unknown_plan",
      message: "Choose their plan first. The link charges whatever plan is saved.",
    };
  }

  return checkoutFor(db, client, { ...urls, planKey: assigned.planKey });
}

function isPublishedPlan(key: string): boolean {
  return PLANS.some((plan) => plan.key === key);
}

const NOT_CONFIGURED: StripeCheckoutOutcome = {
  ok: false,
  reason: "not_configured",
  message: "Card payments are not set up yet.",
};

async function checkoutFor(
  db: Database,
  client: ResolvedClient,
  input: BeginStripeCheckoutInput,
): Promise<StripeCheckoutOutcome> {
  if (client.compPlanId) {
    return {
      ok: false,
      reason: "complimentary",
      message:
        "Your account is on a complimentary plan — there is nothing to pay.",
    };
  }

  // Validate the plan key against the database rather than against the
  // TypeScript union: a plan can be deactivated in the database, and a build
  // that still lists it in its enum would happily sell a withdrawn plan.
  const planRows = await db
    .select({
      id: servicePlans.id,
      key: servicePlans.key,
      lookupKey: servicePlans.stripePriceLookupKey,
      active: servicePlans.active,
    })
    .from(servicePlans)
    .where(eq(servicePlans.key, input.planKey))
    .limit(1);

  const plan = planRows[0];
  if (!plan || !plan.active || !plan.lookupKey) {
    return {
      ok: false,
      reason: "unknown_plan",
      message: "That plan is not available.",
    };
  }

  const planKey = planForLookupKey(plan.lookupKey);
  const assigned = await assignedPlanFor(db, client.clientId);

  // A client may choose any published plan, at its published price. Anything
  // else (the $1 test plan) only when an operator assigned it to them: a form
  // edited in devtools must not be a way to pay a dollar a month.
  const offered =
    planKey !== null && (isPublishedPlan(planKey) || assigned?.planKey === planKey);
  if (!planKey || !offered) {
    return {
      ok: false,
      reason: "unknown_plan",
      message: "That plan is not available.",
    };
  }

  try {
    const price = await priceForPlan(planKey);
    if (!price) {
      return {
        ok: false,
        reason: "no_price",
        message: "That plan has no price configured. Please get in touch.",
      };
    }

    const customerId = await ensureCustomer(db, client);

    const existing = await liveSubscription(customerId);
    if (existing) {
      return {
        ok: false,
        reason: "already_subscribed",
        message:
          "You already have an active subscription. Use “Manage billing” to change it.",
      };
    }

    // The day the operator chose, whichever plan the client picked, unless
    // that day is today: see `anchorDayFor`.
    const anchorDay = assigned ? anchorDayFor(assigned.billingDay) : null;
    const billingDay = anchorDay ? String(anchorDay) : "";

    // An attached promo is re-checked here rather than trusted from when it
    // was attached: one that has expired or run out since is dropped, and the
    // client pays the plan price instead of being unable to pay at all.
    const promo = client.promoCodeId ? await usablePromo(client.promoCodeId) : null;
    const promoCodeId = promo?.id ?? "";

    const reusable = await openSessionFor(customerId, price.id, billingDay, promoCodeId);
    if (reusable?.url) {
      return { ok: true, url: reusable.url, sessionId: reusable.id, reused: true };
    }

    const session = await createSession({
      customerId,
      priceId: price.id,
      client,
      planKey,
      billingDay,
      anchorDay,
      promoCodeId,
      urls: input,
    });
    if (!session.url) {
      return {
        ok: false,
        reason: "stripe_failed",
        message: "Stripe did not return a checkout page. Please try again.",
      };
    }

    return { ok: true, url: session.url, sessionId: session.id, reused: false };
  } catch (error) {
    console.error("[stripe:checkout] failed", {
      clientId: client.clientId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return {
      ok: false,
      reason: "stripe_failed",
      message: "We could not start checkout just now. Please try again.",
    };
  }
}

interface SessionInput {
  customerId: string;
  priceId: string;
  client: ResolvedClient;
  planKey: string;
  billingDay: string;
  anchorDay: number | null;
  /** Empty when no promo is attached. */
  promoCodeId: string;
  urls: { successUrl: string; cancelUrl: string };
}

/**
 * The Checkout Session itself.
 *
 * With a promo attached it is applied for them; without one the client gets a
 * box to type a code. Stripe accepts one or the other on a session, never
 * both, and a client who was handed a promo has no code to type.
 *
 * If Stripe refuses the attached promo — a first-time-only code offered to a
 * customer who has paid before is the likely one — the session is made again
 * without it, with the code box instead. A promo is never the reason somebody
 * cannot pay.
 */
async function createSession(input: SessionInput): Promise<Stripe.Checkout.Session> {
  const stripe = requireStripe();
  const { client, planKey, billingDay, anchorDay } = input;

  const create = (promoCodeId: string) =>
    stripe.checkout.sessions.create(
      {
        mode: "subscription",
        customer: input.customerId,
        line_items: [{ price: input.priceId, quantity: 1 }],
        success_url: input.urls.successUrl,
        cancel_url: input.urls.cancelUrl,

        // Both of these carry the tenant. `client_reference_id` survives on the
        // session; the `subscription_data.metadata` copy is what every later
        // subscription and invoice event carries, and without it the receiver
        // would have to resolve tenancy by customer lookup on every event.
        client_reference_id: client.publicId,
        subscription_data: {
          metadata: {
            client_public_id: client.publicId,
            client_id: client.clientId,
            plan_key: planKey,
          },
          // Charged on the day the operator chose. Stripe prorates the first
          // payment to cover the days until then.
          ...(anchorDay ? { billing_cycle_anchor_config: { day_of_month: anchorDay } } : {}),
        },
        metadata: {
          client_public_id: client.publicId,
          client_id: client.clientId,
          plan_key: planKey,
          billing_day: billingDay,
          promo_code_id: promoCodeId,
        },

        // Saves the card for the recurring charge and makes the terms explicit
        // on Stripe's own page, which is where the client is actually
        // authorising them.
        payment_method_collection: "always",
        billing_address_collection: "auto",
        ...(promoCodeId
          ? { discounts: [{ promotion_code: promoCodeId }] }
          : { allow_promotion_codes: true }),
      },
      {
        // Not time-bucketed. A stable key per (client, price, promo) means a
        // burst of retries collapses to one session; once that session is
        // consumed or expires, `openSessionFor` stops finding it and a
        // genuinely new attempt gets a new key because the previous one is no
        // longer open.
        idempotencyKey: `checkout:${client.clientId}:${input.priceId}:${billingDay || "now"}:${promoCodeId || "nopromo"}`,
      },
    );

  if (!input.promoCodeId) return create("");

  try {
    return await create(input.promoCodeId);
  } catch (error) {
    // Only a refusal of the request. An outage is not a reason to quietly
    // charge someone the full price they were told would be discounted.
    if ((error as { type?: string } | null)?.type !== "StripeInvalidRequestError") throw error;
    console.error("[stripe:checkout] promo refused, continuing without it", {
      clientId: client.clientId,
      promoCodeId: input.promoCodeId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return create("");
  }
}

/**
 * A Stripe Customer Portal session for the signed-in client.
 *
 * The authorisation is the whole point of this function existing server-side:
 * the customer id comes from the tenant's own row, never from the request, so
 * there is no input that could make it open somebody else's billing. A portal
 * session URL is a bearer credential for that customer's entire billing
 * history — payment methods, invoices, addresses — and handing one to the
 * wrong client is a data breach, not a bug.
 */
export async function createBillingPortalSession(
  db: Database,
  ctx: TenantContext,
  returnUrl: string,
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  if (!stripeConfigured()) {
    return { ok: false, message: "Card payments are not set up yet." };
  }

  const client = await resolveClient(db, ctx);
  if (!client?.stripeCustomerId) {
    return { ok: false, message: "There is no card billing on this account." };
  }

  try {
    const stripe = requireStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: client.stripeCustomerId,
      return_url: returnUrl,
    });
    return { ok: true, url: session.url };
  } catch (error) {
    console.error("[stripe:portal] failed", {
      clientId: client.clientId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return { ok: false, message: "We could not open billing just now." };
  }
}

/** Exposed for the reconciliation job, which needs the same live-status rule. */
export { liveSubscription };
