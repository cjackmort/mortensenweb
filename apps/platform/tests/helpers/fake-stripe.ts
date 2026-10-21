import type Stripe from "stripe";

/**
 * Stripe at the network edge, in memory.
 *
 * Suites mock `requireStripe` to return `fakeStripe.client`, so everything
 * above the SDK — lookup keys, mode checks, the repositories — runs for real.
 * State is a module singleton shared by the mock factory and the suite; call
 * `resetFakeStripe()` in `beforeEach`.
 *
 * It keeps Stripe's awkward habits where code depends on them: a coupon's
 * `applies_to` only comes back when expanded, deleting a subscription's last
 * item is refused, and promotion codes are looked up case-insensitively.
 */

type Row = Record<string, unknown>;

export interface FakeCoupon {
  id: string;
  valid: boolean;
  percent_off: number | null;
  amount_off: number | null;
  currency: string | null;
  duration: "once" | "repeating" | "forever";
  duration_in_months: number | null;
  name: string | null;
  redeem_by: number | null;
  max_redemptions: number | null;
  times_redeemed: number;
  applies_to?: { products: string[] };
  metadata: Record<string, string>;
}

export interface FakePromo {
  id: string;
  object: "promotion_code";
  code: string;
  active: boolean;
  expires_at: number | null;
  max_redemptions: number | null;
  times_redeemed: number;
  customer: string | null;
  promotion: { type: "coupon"; coupon: string };
  restrictions: { first_time_transaction: boolean; minimum_amount: number | null };
  metadata: Record<string, string>;
  created: number;
}

export interface FakeSubscription {
  id: string;
  object: "subscription";
  customer: string;
  status: Stripe.Subscription.Status;
  cancel_at_period_end: boolean;
  start_date: number;
  billing_cycle_anchor: number;
  metadata: Record<string, string>;
  discounts: unknown[];
  items: { data: FakeItem[] };
}

export interface FakeItem {
  id: string;
  object: "subscription_item";
  subscription: string;
  current_period_end: number;
  price: { id: string; lookup_key: string | null; unit_amount: number; currency: string; product: string };
  metadata: Record<string, string>;
}

const state = {
  counter: 0,
  prices: new Map<string, Row>(),
  coupons: new Map<string, FakeCoupon>(),
  promos: new Map<string, FakePromo>(),
  sessions: new Map<string, Row>(),
  subscriptions: new Map<string, FakeSubscription>(),
  customers: new Map<string, Row>(),
  created: [] as Array<{ params: Stripe.Checkout.SessionCreateParams; options?: Stripe.RequestOptions }>,
  expired: [] as string[],
  calls: [] as string[],
  /** Make every call throw this, to stand in for an outage. */
  outage: null as Error | null,
};

function nextId(prefix: string): string {
  state.counter += 1;
  return `${prefix}_${state.counter}`;
}

function guard(call: string): void {
  state.calls.push(call);
  if (state.outage) throw state.outage;
}

function invalid(message: string): Error {
  return Object.assign(new Error(message), { type: "StripeInvalidRequestError" });
}

export function resetFakeStripe(): void {
  // The counter is not reset: ids stay unique across tests, as Stripe's are,
  // because a reused customer id trips the unique index on clients.
  state.prices.clear();
  state.coupons.clear();
  state.promos.clear();
  state.sessions.clear();
  state.subscriptions.clear();
  state.customers.clear();
  state.created.length = 0;
  state.expired.length = 0;
  state.calls.length = 0;
  state.outage = null;
}

/** A price with a lookup key, as `stripe:setup` creates them. */
export function addPrice(lookupKey: string, unitAmount: number, product: string, recurring = true): Row {
  const price = {
    id: `price_${lookupKey}`,
    object: "price",
    lookup_key: lookupKey,
    unit_amount: unitAmount,
    currency: "usd",
    product,
    active: true,
    recurring: recurring ? { interval: "month" } : null,
  };
  state.prices.set(lookupKey, price);
  return price;
}

export function addCoupon(coupon: Partial<FakeCoupon> & { id: string }): FakeCoupon {
  const full: FakeCoupon = {
    valid: true,
    percent_off: null,
    amount_off: null,
    currency: "usd",
    duration: "once",
    duration_in_months: null,
    name: null,
    redeem_by: null,
    max_redemptions: null,
    times_redeemed: 0,
    metadata: {},
    ...coupon,
  };
  state.coupons.set(full.id, full);
  return full;
}

export function addPromo(promo: Partial<FakePromo> & { id: string; code: string; coupon: string }): FakePromo {
  const { coupon, ...rest } = promo;
  const full: FakePromo = {
    object: "promotion_code",
    active: true,
    expires_at: null,
    max_redemptions: null,
    times_redeemed: 0,
    customer: null,
    promotion: { type: "coupon", coupon },
    restrictions: { first_time_transaction: false, minimum_amount: null },
    metadata: {},
    created: 1_790_000_000 + state.counter,
    ...rest,
  };
  state.promos.set(full.id, full);
  return full;
}

export function addSubscription(input: {
  customer: string;
  items: Array<{ lookupKey: string; unitAmount: number; product?: string; periodEnd: number }>;
  metadata?: Record<string, string>;
  status?: Stripe.Subscription.Status;
}): FakeSubscription {
  const id = nextId("sub");
  const sub: FakeSubscription = {
    id,
    object: "subscription",
    customer: input.customer,
    status: input.status ?? "active",
    cancel_at_period_end: false,
    start_date: 1_790_000_000,
    billing_cycle_anchor: 1_790_000_000,
    metadata: input.metadata ?? {},
    discounts: [],
    items: {
      data: input.items.map((item) => ({
        id: nextId("si"),
        object: "subscription_item",
        subscription: id,
        current_period_end: item.periodEnd,
        price: {
          id: `price_${item.lookupKey}`,
          lookup_key: item.lookupKey,
          unit_amount: item.unitAmount,
          currency: "usd",
          product: item.product ?? `prod_${item.lookupKey}`,
        },
        metadata: {},
      })),
    },
  };
  state.subscriptions.set(id, sub);
  return sub;
}

function findItem(itemId: string): { sub: FakeSubscription; index: number } | null {
  for (const sub of state.subscriptions.values()) {
    const index = sub.items.data.findIndex((i) => i.id === itemId);
    if (index >= 0) return { sub, index };
  }
  return null;
}

function couponView(coupon: FakeCoupon, expand: string[] | undefined): FakeCoupon {
  if (expand?.includes("applies_to")) return { ...coupon };
  const { applies_to: _hidden, ...rest } = coupon;
  return rest as FakeCoupon;
}

function sessionFrom(params: Stripe.Checkout.SessionCreateParams): Row {
  const id = nextId("cs_test");
  const lines = (params.line_items ?? []).map((line) => {
    const price = [...state.prices.values()].find((p) => p.id === line.price);
    const amount = (price?.unit_amount as number | undefined) ?? line.price_data?.unit_amount ?? 0;
    return { price: price ?? { id: null, product: line.price_data?.product }, amount_total: amount, quantity: line.quantity };
  });
  return {
    id,
    object: "checkout.session",
    url: `https://checkout.stripe.test/${id}`,
    status: "open",
    mode: params.mode,
    payment_status: "unpaid",
    amount_total: lines.reduce((sum, l) => sum + l.amount_total, 0),
    currency: "usd",
    customer: params.customer,
    metadata: params.metadata ?? {},
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    payment_intent: null,
    subscription: null,
    invoice: null,
    line_items: { data: lines },
    livemode: false,
  };
}

export const fakeStripe = {
  state,
  client: {
    customers: {
      create: async (params: Row) => {
        guard("customers.create");
        const customer = { id: nextId("cus"), object: "customer", ...params };
        state.customers.set(customer.id, customer);
        return customer;
      },
      retrieve: async (id: string) => {
        guard("customers.retrieve");
        return state.customers.get(id) ?? { id, deleted: true };
      },
    },
    prices: {
      list: async (params: { lookup_keys?: string[] }) => {
        guard("prices.list");
        const keys = params.lookup_keys ?? [];
        return { data: keys.map((k) => state.prices.get(k)).filter(Boolean) };
      },
    },
    coupons: {
      retrieve: async (id: string, params?: { expand?: string[] }) => {
        guard("coupons.retrieve");
        const coupon = state.coupons.get(id);
        if (!coupon) throw invalid(`No such coupon: ${id}`);
        return couponView(coupon, params?.expand);
      },
      create: async (params: Stripe.CouponCreateParams, options?: Stripe.RequestOptions) => {
        guard("coupons.create");
        const coupon = addCoupon({
          id: nextId("coupon"),
          percent_off: params.percent_off ?? null,
          amount_off: params.amount_off ?? null,
          currency: params.currency ?? null,
          duration: (params.duration ?? "once") as FakeCoupon["duration"],
          name: params.name ?? null,
          applies_to: params.applies_to?.products ? { products: params.applies_to.products } : undefined,
          metadata: (params.metadata ?? {}) as Record<string, string>,
        });
        state.calls.push(`idempotency:${options?.idempotencyKey ?? ""}`);
        return couponView(coupon, undefined);
      },
    },
    promotionCodes: {
      list: async (params: { code?: string; active?: boolean; limit?: number } = {}) => {
        guard("promotionCodes.list");
        const data = [...state.promos.values()]
          .filter((p) => (params.code ? p.code.toLowerCase() === params.code.toLowerCase() : true))
          .filter((p) => (params.active === undefined ? true : p.active === params.active))
          .sort((a, b) => b.created - a.created);
        return { data };
      },
      retrieve: async (id: string) => {
        guard("promotionCodes.retrieve");
        const promo = state.promos.get(id);
        if (!promo) throw invalid(`No such promotion code: ${id}`);
        return promo;
      },
      create: async (params: Stripe.PromotionCodeCreateParams) => {
        guard("promotionCodes.create");
        if ([...state.promos.values()].some((p) => p.active && p.code.toLowerCase() === params.code?.toLowerCase())) {
          throw invalid("An active promotion code with that code already exists.");
        }
        return addPromo({
          id: nextId("promo"),
          code: params.code ?? `CODE${state.counter}`,
          coupon: params.promotion.coupon!,
          expires_at: params.expires_at ?? null,
          max_redemptions: params.max_redemptions ?? null,
          metadata: (params.metadata ?? {}) as Record<string, string>,
        });
      },
      update: async (id: string, params: { active?: boolean }) => {
        guard("promotionCodes.update");
        const promo = state.promos.get(id);
        if (!promo) throw invalid(`No such promotion code: ${id}`);
        if (params.active !== undefined) promo.active = params.active;
        return promo;
      },
    },
    checkout: {
      sessions: {
        list: async (params: { customer?: string; status?: string }) => {
          guard("checkout.sessions.list");
          const data = [...state.sessions.values()]
            .filter((s) => !params.customer || s.customer === params.customer)
            .filter((s) => !params.status || s.status === params.status);
          return { data };
        },
        create: async (params: Stripe.Checkout.SessionCreateParams, options?: Stripe.RequestOptions) => {
          guard("checkout.sessions.create");
          state.created.push({ params, options });
          const session = sessionFrom(params);
          state.sessions.set(String(session.id), session);
          return session;
        },
        retrieve: async (id: string) => {
          guard("checkout.sessions.retrieve");
          const session = state.sessions.get(id);
          if (!session) throw invalid(`No such checkout session: ${id}`);
          return session;
        },
        expire: async (id: string) => {
          guard("checkout.sessions.expire");
          const session = state.sessions.get(id);
          if (!session) throw invalid(`No such checkout session: ${id}`);
          session.status = "expired";
          state.expired.push(id);
          return session;
        },
      },
    },
    subscriptions: {
      list: async (params: { customer?: string }) => {
        guard("subscriptions.list");
        return { data: [...state.subscriptions.values()].filter((s) => s.customer === params.customer) };
      },
      retrieve: async (id: string) => {
        guard("subscriptions.retrieve");
        const sub = state.subscriptions.get(id);
        if (!sub) throw invalid(`No such subscription: ${id}`);
        return sub;
      },
      update: async (id: string, params: Stripe.SubscriptionUpdateParams) => {
        guard("subscriptions.update");
        const sub = state.subscriptions.get(id);
        if (!sub) throw invalid(`No such subscription: ${id}`);
        if (params.cancel_at_period_end !== undefined) sub.cancel_at_period_end = params.cancel_at_period_end;
        return sub;
      },
    },
    subscriptionItems: {
      retrieve: async (id: string) => {
        guard("subscriptionItems.retrieve");
        const found = findItem(id);
        if (!found) throw invalid(`No such subscription item: ${id}`);
        return found.sub.items.data[found.index];
      },
      create: async (params: Stripe.SubscriptionItemCreateParams) => {
        guard("subscriptionItems.create");
        const sub = state.subscriptions.get(params.subscription);
        if (!sub) throw invalid(`No such subscription: ${params.subscription}`);
        const price = [...state.prices.values()].find((p) => p.id === params.price);
        if (!price) throw invalid(`No such price: ${params.price}`);
        const item: FakeItem = {
          id: nextId("si"),
          object: "subscription_item",
          subscription: sub.id,
          current_period_end: sub.items.data[0]?.current_period_end ?? 1_790_000_000,
          price: {
            id: String(price.id),
            lookup_key: price.lookup_key as string,
            unit_amount: price.unit_amount as number,
            currency: "usd",
            product: String(price.product),
          },
          metadata: (params.metadata ?? {}) as Record<string, string>,
        };
        sub.items.data.push(item);
        return item;
      },
      del: async (id: string) => {
        guard("subscriptionItems.del");
        const found = findItem(id);
        if (!found) throw invalid(`No such subscription item: ${id}`);
        if (found.sub.items.data.length === 1) {
          throw invalid("A subscription must have at least one active plan.");
        }
        found.sub.items.data.splice(found.index, 1);
        return { id, deleted: true };
      },
    },
  },
};
