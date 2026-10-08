/**
 * Check a Stripe account is ready for the portal, and fix what can be fixed.
 *
 * A new account — and every account's live mode — starts empty. Checkout
 * resolves a plan by price *lookup key*, so until the care-plan prices and the
 * operator-only test plan exist with exactly the keys in
 * `lib/payments/stripe.ts`, every "Set up automatic payment" answers "That plan
 * has no price configured". This makes
 * them, subscribes the webhook endpoint to the events the receiver handles,
 * and checks the one thing only the dashboard can do: the customer portal.
 *
 * Read-only unless `--apply` is passed, so the first run is a report.
 *
 *   npm run stripe:setup --workspace apps/platform
 *   npm run stripe:setup --workspace apps/platform -- --apply
 *
 * Reads STRIPE_SECRET_KEY from `apps/platform/.env.stripe` (ignored by Git).
 * Never pass the key on the command line: it ends up in shell history. The
 * key decides test or live, the same rule the portal itself follows.
 *
 * `--portal=https://…` points the webhook somewhere other than production.
 */

import { PLANS } from "@mortensenweb/plans";
import {
  HANDLED_STRIPE_EVENTS,
  lookupKeyForAddOn,
  lookupKeyForPlan,
  modeFromKey,
  sellableAddOns,
  requireStripe,
  STRIPE_API_VERSION,
  TEST_PLAN,
  type SellableKey,
} from "@/lib/payments/stripe";

const DEFAULT_PORTAL = "https://portal.mortensenweb.com";
const apply = process.argv.includes("--apply");
const portalArg = process.argv.find((a) => a.startsWith("--portal="));
const portal = (portalArg?.slice("--portal=".length) ?? DEFAULT_PORTAL).replace(/\/$/, "");
const webhookUrl = `${portal}/api/webhooks/stripe`;

let problems = 0;

function report(status: "ok" | "todo" | "done" | "FIX", line: string): void {
  if (status === "FIX" || status === "todo") problems += 1;
  console.log(`  [${status.padEnd(4)}] ${line}`);
}

async function ensurePrices(): Promise<void> {
  const stripe = requireStripe();
  console.log("\nPrices");

  // The published plans, the operator-only $1 test plan, and a price for
  // each Growth add-on that is built — an unbuilt one is never sold.
  const sellable: Array<{ lookupKey: string; name: string; monthlyCents: number; metadata: Record<string, string> }> = [
    ...[...PLANS, TEST_PLAN].map((p) => ({
      lookupKey: lookupKeyForPlan(p.key as SellableKey)!,
      name: p.name,
      monthlyCents: p.monthlyCents,
      metadata: { plan_key: p.key },
    })),
    ...sellableAddOns().map((a) => ({
      lookupKey: lookupKeyForAddOn(a.key),
      name: a.name,
      monthlyCents: a.monthlyCents,
      metadata: { growth_feature: a.key },
    })),
  ];

  for (const plan of sellable) {
    const lookupKey = plan.lookupKey;
    const found = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
    const price = found.data[0];

    if (price) {
      const right =
        price.unit_amount === plan.monthlyCents &&
        price.currency === "usd" &&
        price.recurring?.interval === "month";
      // A wrong price is never edited here — Stripe prices are immutable, and
      // moving the key to a new one changes what new subscribers pay.
      report(
        right ? "ok" : "FIX",
        right
          ? `${lookupKey} → ${price.id} ($${plan.monthlyCents / 100}/month)`
          : `${lookupKey} → ${price.id} is ${price.unit_amount} ${price.currency}/${price.recurring?.interval}, ` +
              `expected ${plan.monthlyCents} usd/month. Create a _v2 price and move the key.`,
      );
      continue;
    }

    if (!apply) {
      report("todo", `${lookupKey} missing — would create "${plan.name}" at $${plan.monthlyCents / 100}/month`);
      continue;
    }

    const created = await stripe.prices.create(
      {
        currency: "usd",
        unit_amount: plan.monthlyCents,
        recurring: { interval: "month" },
        lookup_key: lookupKey,
        nickname: plan.name,
        product_data: { name: plan.name, metadata: plan.metadata },
        metadata: plan.metadata,
      },
      { idempotencyKey: `stripe-setup:price:${lookupKey}` },
    );
    report("done", `${lookupKey} → created ${created.id}`);
  }
}

async function ensureWebhook(): Promise<void> {
  const stripe = requireStripe();
  const wanted = [...HANDLED_STRIPE_EVENTS].sort();
  console.log(`\nWebhook — ${webhookUrl}`);

  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
  const existing = endpoints.data.find((e) => e.url === webhookUrl);

  if (!existing) {
    if (!apply) {
      report("todo", `no endpoint — would create one for ${wanted.length} events`);
      return;
    }
    const created = await stripe.webhookEndpoints.create({
      url: webhookUrl,
      enabled_events: wanted as never,
      // Pinned to the version the receiver parses, so payloads keep the shape
      // the code was written against when the account default moves on.
      api_version: STRIPE_API_VERSION,
      description: "MortensenWeb portal",
    });
    report("done", `created ${created.id}`);
    console.log(
      "\n  Signing secret (shown once here; the dashboard can reveal it again):\n" +
        `\n    ${created.secret}\n\n` +
        "  Set it as STRIPE_WEBHOOK_SECRET in Netlify, then redeploy.",
    );
    return;
  }

  const have = new Set(existing.enabled_events);
  const missing = wanted.filter((e) => !have.has(e));
  if (existing.status !== "enabled") report("FIX", `${existing.id} is ${existing.status}`);
  if (missing.length === 0) {
    report("ok", `${existing.id} subscribed to all ${wanted.length} events`);
    return;
  }
  if (!apply) {
    report("todo", `${existing.id} missing: ${missing.join(", ")}`);
    return;
  }
  await stripe.webhookEndpoints.update(existing.id, {
    enabled_events: [...new Set([...existing.enabled_events, ...missing])] as never,
  });
  report("done", `${existing.id} now subscribed to ${missing.join(", ")}`);
}

async function checkCustomerPortal(): Promise<void> {
  console.log("\nCustomer portal (Manage billing)");
  const found = await requireStripe().billingPortal.configurations.list({
    is_default: true,
    limit: 1,
  });
  // Only the dashboard creates the default configuration, and without it every
  // "Manage billing" click fails in live mode.
  report(
    found.data[0] ? "ok" : "FIX",
    found.data[0]
      ? `default configuration ${found.data[0].id}`
      : "not set up — Dashboard → Settings → Billing → Customer portal → Save",
  );
}

async function main(): Promise<void> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error(
      "STRIPE_SECRET_KEY is not set.\n" +
        "Put it in apps/platform/.env.stripe (ignored by Git), then run this again.",
    );
    process.exitCode = 1;
    return;
  }

  const live = modeFromKey(key).livemode;
  console.log(`Stripe ${live ? "LIVE" : "test"} mode${apply ? "" : " — report only, pass --apply to make changes"}`);

  await ensurePrices();
  await ensureWebhook();
  await checkCustomerPortal();

  console.log(problems === 0 ? "\nNothing left to do here." : `\n${problems} item(s) need attention.`);
  if (problems > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
