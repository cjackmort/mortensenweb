/**
 * A stand-in for Stripe's API on localhost, for clicking through the cart and
 * the Plan tab in a local preview with no Stripe account.
 *
 *   npm run stripe:fake --workspace apps/platform        # listens on :12111
 *
 * The portal only talks to it when `STRIPE_API_BASE=http://localhost:12111`
 * is set with a `sk_test_` key outside production (`localStripeHost`). It
 * answers the calls the cart, promo codes and cancellations make, from
 * memory, with the prices from `@mortensenweb/plans` and three codes:
 * WELCOME100 ($100 off the website), QUARTER (25% off the website) and
 * HALF50 (50% off everything, as a code made in the dashboard without the
 * restriction would be — the cart refuses it). A checkout "page" shows what
 * Stripe was asked to charge. Nothing persists; restarting resets it.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BUILDS, PLANS } from "@mortensenweb/plans";
import { lookupKeyForBuild } from "@/lib/payments/build";
import { lookupKeyForAddOn, lookupKeyForPlan, sellableAddOns, type SellableKey } from "@/lib/payments/stripe";
import { PREVIEW, previewPeriodEnd } from "./fixtures";

type Obj = Record<string, unknown>;

const PORT = Number(process.env.FAKE_STRIPE_PORT ?? 12111);
let counter = 0;
const id = (prefix: string) => `${prefix}_local${++counter}`;
const now = () => Math.floor(Date.now() / 1000);

const prices = new Map<string, Obj>();
const coupons = new Map<string, Obj>();
const promos = new Map<string, Obj>();
const customers = new Map<string, Obj>();
const sessions = new Map<string, Obj>();
const subscriptions = new Map<string, Obj>();

function addPrice(lookupKey: string, cents: number, product: string, recurring: boolean): Obj {
  const price = {
    id: `price_${lookupKey}`,
    object: "price",
    active: true,
    lookup_key: lookupKey,
    unit_amount: cents,
    currency: "usd",
    product,
    recurring: recurring ? { interval: "month" } : null,
  };
  prices.set(lookupKey, price);
  return price;
}

function stock(): void {
  for (const plan of PLANS) addPrice(lookupKeyForPlan(plan.key as SellableKey)!, plan.monthlyCents, `prod_${plan.key}`, true);
  for (const addOn of sellableAddOns()) addPrice(lookupKeyForAddOn(addOn.key), addOn.monthlyCents, `prod_${addOn.key}`, true);
  for (const build of BUILDS) addPrice(lookupKeyForBuild(build.key), build.priceCents, PREVIEW.buildProduct, false);

  const coupon = (couponId: string, terms: Obj) =>
    coupons.set(couponId, { id: couponId, object: "coupon", valid: true, duration: "once", currency: "usd", percent_off: null, amount_off: null, redeem_by: null, max_redemptions: null, times_redeemed: 0, name: null, ...terms });
  const promo = (promoId: string, code: string, couponId: string) =>
    promos.set(promoId, { id: promoId, object: "promotion_code", code, active: true, customer: null, expires_at: null, max_redemptions: null, times_redeemed: 0, promotion: { type: "coupon", coupon: couponId }, restrictions: { first_time_transaction: false, minimum_amount: null }, created: now() });

  coupon("co_preview_web100", { amount_off: 10000, applies_to: { products: [PREVIEW.buildProduct] } });
  promo("promo_preview_web100", "WELCOME100", "co_preview_web100");
  coupon("co_preview_quarter", { percent_off: 25, currency: null, applies_to: { products: [PREVIEW.buildProduct] } });
  promo("promo_preview_quarter", "QUARTER", "co_preview_quarter");
  coupon("co_preview_half", { percent_off: 50, currency: null });
  promo("promo_preview_half", "HALF50", "co_preview_half");

  const paying = PREVIEW.paying;
  const periodEnd = Math.floor(previewPeriodEnd().getTime() / 1000);
  const item = (itemId: string, lookupKey: string) => ({ id: itemId, object: "subscription_item", subscription: paying.subscription, current_period_end: periodEnd, price: prices.get(lookupKey), metadata: {} });
  customers.set(paying.customer, { id: paying.customer, object: "customer", metadata: {} });
  subscriptions.set(paying.subscription, {
    id: paying.subscription,
    object: "subscription",
    customer: paying.customer,
    status: "active",
    cancel_at_period_end: false,
    start_date: now() - 10 * 86_400,
    billing_cycle_anchor: now() - 10 * 86_400,
    metadata: {},
    discounts: [],
    items: {
      object: "list",
      data: [
        item(paying.planItem, lookupKeyForPlan(paying.planKey as SellableKey)!),
        item(paying.addOnItem, lookupKeyForAddOn(paying.addOnKey)),
      ],
    },
  });
}

/** `line_items[0][price]=x` style form fields, as nested objects and arrays. */
function nested(params: URLSearchParams): Obj {
  const root: Obj = {};
  for (const [key, value] of params) {
    const parts = key.split(/\[|\]/).filter(Boolean);
    let node: Obj = root;
    parts.forEach((part, index) => {
      const last = index === parts.length - 1;
      if (last) {
        node[part] = value;
        return;
      }
      if (node[part] === undefined) node[part] = /^\d+$/.test(parts[index + 1]!) ? [] : {};
      node = node[part] as Obj;
    });
  }
  return root;
}

const list = (data: unknown[], url: string) => ({ object: "list", data, has_more: false, url });
const asArray = (value: unknown): string[] => (Array.isArray(value) ? (value as string[]) : value ? [String(value)] : []);

function couponView(coupon: Obj, expand: string[]): Obj {
  if (expand.includes("applies_to")) return coupon;
  const { applies_to: _hidden, ...rest } = coupon;
  return rest;
}

function lineAmount(line: Obj): { amount: number; product: string; name: string } {
  const priceId = line.price as string | undefined;
  if (priceId) {
    const price = [...prices.values()].find((p) => p.id === priceId)!;
    return { amount: price.unit_amount as number, product: price.product as string, name: price.lookup_key as string };
  }
  const data = line.price_data as Obj;
  return { amount: Number(data.unit_amount), product: data.product as string, name: "quoted build" };
}

function createSession(body: Obj): Obj {
  const sessionId = id("cs_test");
  const discount = (body.discounts as Obj[] | undefined)?.[0]?.promotion_code as string | undefined;
  const coupon = discount ? coupons.get((promos.get(discount)!.promotion as Obj).coupon as string) : undefined;
  const lines = ((body.line_items as Obj[]) ?? []).map((line) => {
    const { amount, product, name } = lineAmount(line);
    const restricted = (coupon?.applies_to as Obj | undefined)?.products as string[] | undefined;
    const applies = coupon && (!restricted || restricted.includes(product));
    const off = !applies ? 0 : coupon.percent_off ? Math.round((amount * Number(coupon.percent_off)) / 100) : Math.min(amount, Number(coupon.amount_off));
    return { description: name, amount_subtotal: amount, amount_discount: off, amount_total: amount - off, price: { product } };
  });
  const session = {
    id: sessionId,
    object: "checkout.session",
    mode: body.mode,
    status: "open",
    payment_status: "unpaid",
    customer: body.customer,
    metadata: body.metadata ?? {},
    url: `http://localhost:${PORT}/checkout/${sessionId}`,
    expires_at: now() + 86_400,
    amount_total: lines.reduce((sum, l) => sum + l.amount_total, 0),
    currency: "usd",
    line_items: list(lines, ""),
    discounts: body.discounts ?? [],
  };
  sessions.set(sessionId, session);
  return session;
}

function checkoutPage(session: Obj): string {
  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const lines = ((session.line_items as Obj).data as Obj[])
    .map((l) => `<tr><td>${l.description}</td><td>${l.amount_discount ? `<s>${money(Number(l.amount_subtotal))}</s> ` : ""}${money(Number(l.amount_total))}</td></tr>`)
    .join("");
  return `<!doctype html><meta charset="utf-8"><title>Stripe stand-in</title>
<body style="font:16px system-ui;max-width:560px;margin:40px auto;padding:0 16px">
<p style="color:#9a4a07"><strong>Local stand-in for Stripe Checkout.</strong> Nothing is charged.</p>
<h1 style="font-size:1.3rem">Mode: ${session.mode}</h1>
<table style="width:100%;border-collapse:collapse">${lines}
<tr><th style="text-align:left;border-top:2px solid">Due today</th><th style="text-align:left;border-top:2px solid">${money(Number(session.amount_total))}</th></tr></table>
<p>Promotion code: ${((session.discounts as Obj[])[0]?.promotion_code as string) ?? "none"}</p></body>`;
}

type Handler = (match: RegExpMatchArray, query: Obj, body: Obj) => [number, unknown];

const routes: Array<[string, RegExp, Handler]> = [
  ["GET", /^\/v1\/prices$/, (_m, q) => [200, list(asArray(q.lookup_keys).map((k) => prices.get(k)).filter(Boolean), "/v1/prices")]],
  ["GET", /^\/v1\/promotion_codes$/, (_m, q) => {
    const code = (q.code as string | undefined)?.toLowerCase();
    const data = [...promos.values()].filter((p) => (!code || String(p.code).toLowerCase() === code) && (q.active === undefined || String(p.active) === q.active));
    return [200, list(data, "/v1/promotion_codes")];
  }],
  ["GET", /^\/v1\/promotion_codes\/([^/]+)$/, (m) => (promos.has(m[1]!) ? [200, promos.get(m[1]!)] : [404, missing("promotion code", m[1]!)])],
  ["POST", /^\/v1\/promotion_codes$/, (_m, _q, b) => {
    const promoId = id("promo");
    promos.set(promoId, { id: promoId, object: "promotion_code", code: b.code, active: true, customer: null, expires_at: b.expires_at ? Number(b.expires_at) : null, max_redemptions: b.max_redemptions ? Number(b.max_redemptions) : null, times_redeemed: 0, promotion: { type: "coupon", coupon: (b.promotion as Obj).coupon }, restrictions: { first_time_transaction: false, minimum_amount: null }, created: now() });
    return [200, promos.get(promoId)];
  }],
  ["POST", /^\/v1\/promotion_codes\/([^/]+)$/, (m, _q, b) => {
    const promo = promos.get(m[1]!);
    if (!promo) return [404, missing("promotion code", m[1]!)];
    if (b.active !== undefined) promo.active = b.active === "true";
    return [200, promo];
  }],
  ["GET", /^\/v1\/coupons\/([^/]+)$/, (m, q) => (coupons.has(m[1]!) ? [200, couponView(coupons.get(m[1]!)!, asArray(q.expand))] : [404, missing("coupon", m[1]!)])],
  ["POST", /^\/v1\/coupons$/, (_m, _q, b) => {
    const couponId = id("coupon");
    const scope = (b.applies_to as Obj | undefined)?.products;
    coupons.set(couponId, { id: couponId, object: "coupon", valid: true, duration: b.duration ?? "once", currency: b.currency ?? null, percent_off: b.percent_off ? Number(b.percent_off) : null, amount_off: b.amount_off ? Number(b.amount_off) : null, redeem_by: null, max_redemptions: null, times_redeemed: 0, name: b.name ?? null, ...(scope ? { applies_to: { products: asArray(scope) } } : {}) });
    return [200, couponView(coupons.get(couponId)!, [])];
  }],
  ["POST", /^\/v1\/customers$/, (_m, _q, b) => {
    const customer = { id: id("cus"), object: "customer", ...b };
    customers.set(customer.id, customer);
    return [200, customer];
  }],
  ["GET", /^\/v1\/customers\/([^/]+)$/, (m) => [200, customers.get(m[1]!) ?? { id: m[1], object: "customer", deleted: true }]],
  ["GET", /^\/v1\/subscriptions$/, (_m, q) => [200, list([...subscriptions.values()].filter((s) => s.customer === q.customer), "/v1/subscriptions")]],
  ["GET", /^\/v1\/subscriptions\/([^/]+)$/, (m) => (subscriptions.has(m[1]!) ? [200, subscriptions.get(m[1]!)] : [404, missing("subscription", m[1]!)])],
  ["POST", /^\/v1\/subscriptions\/([^/]+)$/, (m, _q, b) => {
    const sub = subscriptions.get(m[1]!);
    if (!sub) return [404, missing("subscription", m[1]!)];
    if (b.cancel_at_period_end !== undefined) sub.cancel_at_period_end = b.cancel_at_period_end === "true";
    return [200, sub];
  }],
  ["POST", /^\/v1\/subscription_items$/, (_m, _q, b) => {
    const sub = subscriptions.get(b.subscription as string)!;
    const price = [...prices.values()].find((p) => p.id === b.price)!;
    const items = (sub.items as Obj).data as Obj[];
    const item = { id: id("si"), object: "subscription_item", subscription: sub.id, current_period_end: items[0]?.current_period_end, price, metadata: b.metadata ?? {} };
    items.push(item);
    return [200, item];
  }],
  ["DELETE", /^\/v1\/subscription_items\/([^/]+)$/, (m) => {
    for (const sub of subscriptions.values()) {
      const items = (sub.items as Obj).data as Obj[];
      const index = items.findIndex((i) => i.id === m[1]);
      if (index >= 0) {
        items.splice(index, 1);
        return [200, { id: m[1], object: "subscription_item", deleted: true }];
      }
    }
    return [404, missing("subscription item", m[1]!)];
  }],
  ["GET", /^\/v1\/checkout\/sessions$/, (_m, q) => [200, list([...sessions.values()].filter((s) => s.customer === q.customer && (!q.status || s.status === q.status)), "/v1/checkout/sessions")]],
  ["POST", /^\/v1\/checkout\/sessions$/, (_m, _q, b) => [200, createSession(b)]],
  ["GET", /^\/v1\/checkout\/sessions\/([^/]+)$/, (m) => (sessions.has(m[1]!) ? [200, sessions.get(m[1]!)] : [404, missing("checkout session", m[1]!)])],
  ["POST", /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/, (m) => {
    const session = sessions.get(m[1]!);
    if (!session) return [404, missing("checkout session", m[1]!)];
    session.status = "expired";
    return [200, session];
  }],
];

function missing(what: string, which: string) {
  return { error: { type: "invalid_request_error", message: `No such ${what}: '${which}'` } };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://localhost:${PORT}`);
  const page = url.pathname.match(/^\/checkout\/([^/]+)$/);
  if (request.method === "GET" && page) {
    const session = sessions.get(page[1]!);
    response.writeHead(session ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    response.end(session ? checkoutPage(session) : "No such checkout.");
    return;
  }

  const query = nested(url.searchParams);
  const body = request.method === "POST" ? nested(new URLSearchParams(await readBody(request))) : {};
  const route = routes.find(([method, pattern]) => method === request.method && pattern.test(url.pathname));
  const [status, payload] = route
    ? route[2](url.pathname.match(route[1])!, query, body)
    : [404, { error: { type: "invalid_request_error", message: `Unrecognized request URL (${request.method}: ${url.pathname})` } }];
  console.log(`${request.method} ${url.pathname} → ${status}`);
  response.writeHead(status, { "content-type": "application/json", "request-id": id("req") });
  response.end(JSON.stringify(payload));
}

stock();
createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { type: "api_error", message: error instanceof Error ? error.message : "failed" } }));
  });
}).listen(PORT, () => console.log(`Stripe stand-in on http://localhost:${PORT} (nothing is charged)`));
