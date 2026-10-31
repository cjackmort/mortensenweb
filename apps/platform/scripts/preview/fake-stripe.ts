/**
 * A stand-in for Stripe on localhost, so the whole checkout can be run — and
 * paid — with no Stripe account, no network and no live key.
 *
 *   npm run stripe:fake --workspace apps/platform        # listens on :12111
 *
 * The portal talks to it only with `STRIPE_API_BASE=http://localhost:12111`,
 * a `sk_test_` key and a non-production `NODE_ENV` (`localStripeHost`).
 *
 * It answers what the welcome checkout calls — customers, prices by lookup
 * key, subscriptions, Checkout Sessions in both modes — from memory, with the
 * prices from `@mortensenweb/plans` and the one-off "Website build" price on
 * its own product (`lib/payments/build.ts`). A session's page has a Pay button; pressing
 * it completes the session and posts the signed events Stripe would
 * (`checkout.session.completed`, and for a subscription also
 * `customer.subscription.created` and `invoice.paid`) to the portal, waiting
 * for each answer before redirecting, so the portal is settled by the time the
 * browser lands on the success page.
 *
 * One promotion code, on a session that allows codes: `BUILD100`, 100% off
 * the Website build product and nothing else — enough to show a build a code
 * took to zero settling as paid. A payment-mode session that comes to $0
 * completes as `no_payment_required`, as Stripe's does.
 *
 * What it does not do: other codes, tax, proration, billing-cycle anchors,
 * renewals, refunds, disputes. A request it does not recognise is answered
 * 404 with its URL, and an input it cannot honour is refused, so a gap shows
 * as a failure rather than as a plausible wrong answer.
 *
 * Nothing persists; restarting resets it. `GET /__fake/events` lists the
 * events delivered and what the portal answered; `POST /__fake/reset` clears
 * the state without a restart.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BUILD, PLANS } from "@mortensenweb/plans";
import { BUILD_PRODUCT_NAME, lookupKeyForBuild } from "@/lib/payments/build";
import { lookupKeyForAddOn, lookupKeyForPlan, sellableAddOns, TEST_PLAN, type SellableKey } from "@/lib/payments/stripe";
import { deliverEvent, eventEnvelope, type DeliveredEvent } from "./fake-stripe-webhooks";

type Obj = Record<string, unknown>;

const PORT = Number(process.env.FAKE_STRIPE_PORT ?? 12111);
const PORTAL_URL = (process.env.PORTAL_URL ?? "http://localhost:3000").replace(/\/$/, "");
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
const PERIOD_SECONDS = 30 * 86_400;
const BUILD_PRODUCT = "prod_website_build";

/** The codes the stand-in knows: percent off, and the one product it comes off. */
const PROMOTION_CODES: Record<string, { percentOff: number; product: string }> = {
  BUILD100: { percentOff: 100, product: BUILD_PRODUCT },
};

interface Line {
  description: string;
  amount: number;
  price: Obj;
  product: string;
  recurring: boolean;
  /** Taken off by a promotion code. */
  discount: number;
}

interface SessionRecord {
  view: Obj;
  lines: Line[];
  subscriptionMetadata: Obj;
  paymentIntent: Obj | null;
  allowPromotionCodes: boolean;
  promotionCode: string | null;
}

interface State {
  prices: Map<string, Obj>;
  customers: Map<string, Obj>;
  sessions: Map<string, SessionRecord>;
  subscriptions: Map<string, Obj>;
  idempotent: Map<string, [number, unknown]>;
  events: DeliveredEvent[];
}

let counter = 0;
const id = (prefix: string) => `${prefix}_fake${++counter}`;
const now = () => Math.floor(Date.now() / 1000);
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const list = (data: unknown[], url: string) => ({ object: "list", data, has_more: false, url });
const asArray = (value: unknown): string[] => (Array.isArray(value) ? (value as string[]) : value ? [String(value)] : []);
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function stockPrices(): Map<string, Obj> {
  const prices = new Map<string, Obj>();
  const add = (lookupKey: string, cents: number, product: string) =>
    prices.set(lookupKey, {
      id: `price_${lookupKey}`,
      object: "price",
      active: true,
      lookup_key: lookupKey,
      unit_amount: cents,
      currency: "usd",
      product,
      recurring: { interval: "month" },
    });
  for (const plan of PLANS) add(lookupKeyForPlan(plan.key as SellableKey)!, plan.monthlyCents, `prod_${plan.key}`);
  add(lookupKeyForPlan(TEST_PLAN.key)!, TEST_PLAN.monthlyCents, `prod_${TEST_PLAN.key}`);
  for (const addOn of sellableAddOns()) add(lookupKeyForAddOn(addOn.key), addOn.monthlyCents, `prod_${addOn.key}`);
  const build = lookupKeyForBuild();
  prices.set(build, {
    id: `price_${build}`,
    object: "price",
    active: true,
    lookup_key: build,
    unit_amount: BUILD.priceCents,
    currency: "usd",
    product: BUILD_PRODUCT,
    recurring: null,
  });
  return prices;
}

const freshState = (): State => ({
  prices: stockPrices(),
  customers: new Map(),
  sessions: new Map(),
  subscriptions: new Map(),
  idempotent: new Map(),
  events: [],
});

let state = freshState();

function missing(what: string, which: string): [number, unknown] {
  return [404, { error: { type: "invalid_request_error", message: `No such ${what}: '${which}'` } }];
}

function refused(message: string): [number, unknown] {
  return [400, { error: { type: "invalid_request_error", message } }];
}

/** `line_items[0][price]=x` style form fields, as nested objects and arrays. */
function nested(params: URLSearchParams): Obj {
  const root: Obj = {};
  for (const [key, value] of params) {
    const parts = key.split(/\[|\]/).filter(Boolean);
    let node: Obj = root;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) {
        node[part] = value;
        return;
      }
      if (node[part] === undefined) node[part] = /^\d+$/.test(parts[index + 1]!) ? [] : {};
      node = node[part] as Obj;
    });
  }
  return root;
}

function toLine(requested: Obj): Line | string {
  const quantity = Number(requested.quantity ?? 1);
  if (quantity !== 1) return "The stand-in only sells quantities of one.";

  if (requested.price) {
    const price = [...state.prices.values()].find((p) => p.id === requested.price);
    if (!price) return `No such price: '${String(requested.price)}'`;
    return {
      description: String(price.lookup_key),
      amount: Number(price.unit_amount),
      price,
      product: String(price.product),
      recurring: Boolean(price.recurring),
      discount: 0,
    };
  }

  const data = requested.price_data as Obj | undefined;
  if (!data) return "A line item needs a price or price_data.";
  if (data.recurring) return "The stand-in does not build recurring prices from price_data.";
  if (data.product && data.product !== BUILD_PRODUCT) return `No such product: '${String(data.product)}'`;
  const product = data.product ? BUILD_PRODUCT : id("prod");
  const name = data.product ? BUILD_PRODUCT_NAME : String((data.product_data as Obj | undefined)?.name ?? "Item");
  const price = { id: id("price_data"), object: "price", unit_amount: Number(data.unit_amount), currency: "usd", recurring: null, lookup_key: null, product };
  return { description: name, amount: Number(data.unit_amount), price, product, recurring: false, discount: 0 };
}

const totalOf = (lines: Line[]) => lines.reduce((sum, l) => sum + l.amount - l.discount, 0);

/** Take a known code off the lines it applies to, and restate the session's totals. */
function applyPromotionCode(record: SessionRecord, code: string): string | null {
  const promo = PROMOTION_CODES[code.trim().toUpperCase()];
  if (!record.allowPromotionCodes) return "This checkout does not take codes.";
  if (!promo) return "That code isn't valid.";
  for (const line of record.lines) {
    line.discount = line.product === promo.product ? Math.round((line.amount * promo.percentOff) / 100) : 0;
  }
  record.promotionCode = code.trim().toUpperCase();
  record.view.amount_total = totalOf(record.lines);
  record.view.total_details = { amount_discount: record.lines.reduce((sum, l) => sum + l.discount, 0) };
  return null;
}

function createSession(body: Obj): [number, unknown] {
  // Accepted by the real thing, absent from this one. Say so rather than charge the full price silently.
  if (body.discounts) return refused("The stand-in does not support discounts.");
  if (body.mode !== "subscription" && body.mode !== "payment") return refused(`Unsupported mode '${String(body.mode)}'.`);

  const lines: Line[] = [];
  for (const requested of (body.line_items as Obj[] | undefined) ?? []) {
    const line = toLine(requested);
    if (typeof line === "string") return refused(line);
    lines.push(line);
  }
  if (lines.length === 0) return refused("A Checkout Session needs at least one line item.");

  const sessionId = id("cs_test");
  const view: Obj = {
    id: sessionId,
    object: "checkout.session",
    livemode: false,
    mode: body.mode,
    status: "open",
    payment_status: "unpaid",
    customer: body.customer ?? null,
    client_reference_id: body.client_reference_id ?? null,
    metadata: body.metadata ?? {},
    success_url: body.success_url,
    cancel_url: body.cancel_url,
    url: `http://localhost:${PORT}/checkout/${sessionId}`,
    expires_at: now() + 86_400,
    currency: "usd",
    amount_subtotal: lines.reduce((sum, l) => sum + l.amount, 0),
    amount_total: lines.reduce((sum, l) => sum + l.amount, 0),
    total_details: { amount_discount: 0 },
    subscription: null,
    payment_intent: null,
    line_items: list(
      lines.map((l) => ({ id: id("li"), object: "item", description: l.description, quantity: 1, amount_total: l.amount, price: l.price })),
      "",
    ),
  };
  const subscriptionMetadata = ((body.subscription_data as Obj | undefined)?.metadata as Obj | undefined) ?? {};
  state.sessions.set(sessionId, {
    view,
    lines,
    subscriptionMetadata,
    paymentIntent: body.mode === "payment" ? { metadata: (body.payment_intent_data as Obj | undefined)?.metadata ?? {} } : null,
    allowPromotionCodes: body.allow_promotion_codes === "true",
    promotionCode: null,
  });
  return [200, view];
}

/** The session as retrieved: `payment_intent` and its charge expanded when asked. */
function sessionView(record: SessionRecord, expand: string[]): Obj {
  const intent = record.paymentIntent;
  if (!intent?.id || !expand.some((e) => e === "payment_intent" || e.startsWith("payment_intent."))) return record.view;
  const charge = intent.latest_charge as Obj;
  const latestCharge = expand.includes("payment_intent.latest_charge") ? charge : charge.id;
  return { ...record.view, payment_intent: { ...intent, latest_charge: latestCharge } };
}

function promotionForm(record: SessionRecord, error: string | null): string {
  if (!record.allowPromotionCodes || record.view.status !== "open") return "";
  if (record.promotionCode) return `<p>Code <strong>${escapeHtml(record.promotionCode)}</strong> applied.</p>`;
  return `<form method="post" action="/checkout/${String(record.view.id)}/promo" style="margin-top:16px">
<label>Promotion code <input name="code" autocomplete="off"></label> <button type="submit">Apply</button>
${error ? `<p role="alert" style="color:#a1001a">${escapeHtml(error)}</p>` : ""}</form>`;
}

function checkoutPage(record: SessionRecord, error: string | null = null): string {
  const rows = record.lines
    .map(
      (l) =>
        `<tr><td>${escapeHtml(l.description)}</td><td>${money(l.amount)}${l.recurring ? " / month" : ""}</td></tr>` +
        (l.discount ? `<tr><td>Discount</td><td>-${money(l.discount)}</td></tr>` : ""),
    )
    .join("");
  const total = Number(record.view.amount_total);
  const sessionId = String(record.view.id);
  const open = record.view.status === "open";
  return `<!doctype html><meta charset="utf-8"><title>Stripe stand-in</title>
<body style="font:16px system-ui;max-width:560px;margin:40px auto;padding:0 16px">
<p style="color:#9a4a07"><strong>Local stand-in for Stripe Checkout.</strong> Nothing is charged.</p>
<h1 style="font-size:1.3rem">Checkout (${escapeHtml(String(record.view.mode))} mode)</h1>
<table style="width:100%;border-collapse:collapse">${rows}
<tr><th style="text-align:left;border-top:2px solid">Due today</th><th style="text-align:left;border-top:2px solid">${money(total)}</th></tr></table>
${promotionForm(record, error)}
${
  open
    ? `<form method="post" action="/checkout/${sessionId}/pay" style="margin-top:24px">
<button type="submit">Pay ${money(total)}</button> <a href="${escapeHtml(String(record.view.cancel_url))}">Cancel</a></form>`
    : `<p>This checkout is ${escapeHtml(String(record.view.status))}.</p>`
}</body>`;
}

async function send(events: Array<[string, unknown]>): Promise<void> {
  for (const [type, object] of events) {
    if (!WEBHOOK_SECRET) {
      console.warn(`[fake-stripe] STRIPE_WEBHOOK_SECRET is not set; not sending ${type}`);
      continue;
    }
    const delivered = await deliverEvent(PORTAL_URL, WEBHOOK_SECRET, eventEnvelope(id("evt"), type, object));
    state.events.push(delivered);
    console.log(`event ${delivered.type} → portal ${delivered.status} ${delivered.outcome ?? ""}`);
  }
}

/** The customer paid: settle the session and tell the portal, in the order Stripe tells it. */
async function completeSession(record: SessionRecord): Promise<void> {
  const view = record.view;
  const total = Number(view.amount_total);
  view.status = "complete";
  view.payment_status = "paid";

  if (view.mode === "payment" && total === 0) {
    // Stripe's answer for a checkout a code took to nothing: complete, no charge.
    view.payment_status = "no_payment_required";
    await send([["checkout.session.completed", view]]);
    return;
  }

  if (view.mode === "payment") {
    const chargeId = id("ch");
    const charge = { id: chargeId, object: "charge", amount: total, paid: true, receipt_url: `http://localhost:${PORT}/receipt/${chargeId}` };
    const intentId = id("pi");
    record.paymentIntent = { ...record.paymentIntent, id: intentId, object: "payment_intent", amount: total, currency: "usd", status: "succeeded", latest_charge: charge };
    view.payment_intent = intentId;
    await send([["checkout.session.completed", view]]);
    return;
  }

  const started = now();
  const subscriptionId = id("sub");
  const recurring = record.lines.filter((l) => l.recurring);
  const subscription: Obj = {
    id: subscriptionId,
    object: "subscription",
    livemode: false,
    customer: view.customer,
    status: "active",
    cancel_at_period_end: false,
    start_date: started,
    billing_cycle_anchor: started,
    metadata: record.subscriptionMetadata,
    discounts: [],
    items: list(
      recurring.map((l) => ({ id: id("si"), object: "subscription_item", subscription: subscriptionId, current_period_end: started + PERIOD_SECONDS, price: l.price, metadata: {} })),
      "",
    ),
  };
  state.subscriptions.set(subscriptionId, subscription);
  view.subscription = subscriptionId;

  const invoiceId = id("in");
  const invoice: Obj = {
    id: invoiceId,
    object: "invoice",
    livemode: false,
    customer: view.customer,
    status: "paid",
    currency: "usd",
    billing_reason: "subscription_create",
    total,
    amount_due: total,
    amount_paid: total,
    hosted_invoice_url: `http://localhost:${PORT}/receipt/${invoiceId}`,
    status_transitions: { paid_at: started },
    // Where the 2025 API versions put what older ones had on the invoice itself.
    parent: { type: "subscription_details", subscription_details: { subscription: subscriptionId, metadata: record.subscriptionMetadata } },
    lines: list(
      record.lines.map((l) => ({
        id: id("il"),
        amount: l.amount,
        discount_amounts: l.discount ? [{ amount: l.discount, discount: "di_fake" }] : [],
        // A subscription's own lines, or the one-off build Checkout adds as an invoice item.
        parent: { type: l.recurring ? "subscription_item_details" : "invoice_item_details" },
        pricing: { price_details: { price: String(l.price.id), product: l.product } },
        period: { start: started, end: l.recurring ? started + PERIOD_SECONDS : started },
      })),
      "",
    ),
  };

  await send([
    ["checkout.session.completed", view],
    ["customer.subscription.created", subscription],
    ["invoice.paid", invoice],
  ]);
}

type Handler = (match: RegExpMatchArray, query: Obj, body: Obj) => [number, unknown];

const routes: Array<[string, RegExp, Handler]> = [
  ["GET", /^\/v1\/prices$/, (_m, q) => [200, list(asArray(q.lookup_keys).map((k) => state.prices.get(k)).filter(Boolean), "/v1/prices")]],
  ["POST", /^\/v1\/customers$/, (_m, _q, b) => {
    const customer = { id: id("cus"), object: "customer", livemode: false, ...b };
    state.customers.set(customer.id, customer);
    return [200, customer];
  }],
  ["GET", /^\/v1\/customers\/([^/]+)$/, (m) => (state.customers.has(m[1]!) ? [200, state.customers.get(m[1]!)] : missing("customer", m[1]!))],
  ["GET", /^\/v1\/subscriptions$/, (_m, q) => [200, list([...state.subscriptions.values()].filter((s) => s.customer === q.customer), "/v1/subscriptions")]],
  ["GET", /^\/v1\/subscriptions\/([^/]+)$/, (m) => (state.subscriptions.has(m[1]!) ? [200, state.subscriptions.get(m[1]!)] : missing("subscription", m[1]!))],
  ["GET", /^\/v1\/checkout\/sessions$/, (_m, q) => {
    const matching = [...state.sessions.values()].filter((s) => (!q.customer || s.view.customer === q.customer) && (!q.status || s.view.status === q.status));
    return [200, list(matching.map((s) => s.view), "/v1/checkout/sessions")];
  }],
  ["POST", /^\/v1\/checkout\/sessions$/, (_m, _q, b) => createSession(b)],
  ["GET", /^\/v1\/checkout\/sessions\/([^/]+)$/, (m, q) => {
    const record = state.sessions.get(m[1]!);
    return record ? [200, sessionView(record, asArray(q.expand))] : missing("checkout session", m[1]!);
  }],
  ["POST", /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/, (m) => {
    const record = state.sessions.get(m[1]!);
    if (!record) return missing("checkout session", m[1]!);
    record.view.status = "expired";
    return [200, record.view];
  }],
];

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function reply(response: ServerResponse, status: number, type: string, payload: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": type, ...headers });
  response.end(payload);
}

/** The pages a browser sees: the checkout, its Pay button, and the receipts it links to. */
async function handlePage(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
  const html = "text/html; charset=utf-8";
  const page = pathname.match(/^\/checkout\/([^/]+)$/);
  if (request.method === "GET" && page) {
    const record = state.sessions.get(page[1]!);
    reply(response, record ? 200 : 404, html, record ? checkoutPage(record) : "No such checkout.");
    return true;
  }

  const promo = pathname.match(/^\/checkout\/([^/]+)\/promo$/);
  if (request.method === "POST" && promo) {
    const record = state.sessions.get(promo[1]!);
    if (!record || record.view.status !== "open") {
      reply(response, 409, html, "This checkout is not open.");
      return true;
    }
    const code = new URLSearchParams(await readBody(request)).get("code") ?? "";
    const error = applyPromotionCode(record, code);
    if (error) {
      reply(response, 400, html, checkoutPage(record, error));
      return true;
    }
    reply(response, 303, html, "", { location: `/checkout/${String(record.view.id)}` });
    return true;
  }

  const pay = pathname.match(/^\/checkout\/([^/]+)\/pay$/);
  if (request.method === "POST" && pay) {
    const record = state.sessions.get(pay[1]!);
    if (!record || record.view.status !== "open") {
      reply(response, 409, html, "This checkout is not open.");
      return true;
    }
    await completeSession(record);
    const target = String(record.view.success_url).replace("{CHECKOUT_SESSION_ID}", String(record.view.id));
    reply(response, 303, html, "", { location: target });
    return true;
  }

  if (request.method === "GET" && pathname.startsWith("/receipt/")) {
    reply(response, 200, html, "<!doctype html><title>Receipt</title><p>Stand-in receipt. Nothing was charged.</p>");
    return true;
  }
  return false;
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://localhost:${PORT}`);
  if (await handlePage(request, response, url.pathname)) return;

  if (url.pathname === "/__fake/events") return reply(response, 200, "application/json", JSON.stringify(state.events));
  if (url.pathname === "/__fake/reset" && request.method === "POST") {
    state = freshState();
    return reply(response, 200, "application/json", "{}");
  }

  const key = request.headers["idempotency-key"];
  const replay = request.method === "POST" && typeof key === "string" ? state.idempotent.get(key) : undefined;
  if (replay) return reply(response, replay[0], "application/json", JSON.stringify(replay[1]), { "idempotent-replayed": "true" });

  const query = nested(url.searchParams);
  const body = request.method === "POST" ? nested(new URLSearchParams(await readBody(request))) : {};
  const route = routes.find(([method, pattern]) => method === request.method && pattern.test(url.pathname));
  const [status, payload] = route
    ? route[2](url.pathname.match(route[1])!, query, body)
    : [404, { error: { type: "invalid_request_error", message: `Unrecognized request URL (${request.method}: ${url.pathname})` } }];
  if (request.method === "POST" && typeof key === "string" && status < 400) state.idempotent.set(key, [status, payload]);
  console.log(`${request.method} ${url.pathname} → ${status}`);
  reply(response, status, "application/json", JSON.stringify(payload), { "request-id": id("req") });
}

createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    console.error("[fake-stripe]", error);
    reply(response, 500, "application/json", JSON.stringify({ error: { type: "api_error", message: error instanceof Error ? error.message : "failed" } }));
  });
}).listen(PORT, () => {
  console.log(`Stripe stand-in on http://localhost:${PORT} (nothing is charged); events go to ${PORTAL_URL}`);
  if (!WEBHOOK_SECRET) console.warn("STRIPE_WEBHOOK_SECRET is not set: payments will complete but the portal will hear nothing.");
});
