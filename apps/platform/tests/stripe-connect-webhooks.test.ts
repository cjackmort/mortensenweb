import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type Stripe from "stripe";
import type { Database } from "@/db/client";
import { shopSettings, sites, webhookDeliveries } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { connectedAccountIdOf } from "@/lib/shop/connect";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * The Connect receiver, against a real database.
 *
 * It decides one thing — whether a shop can take money — so the ways it can
 * go wrong are: switching a shop on from a stale payload, switching the wrong
 * shop, processing the same event twice, and believing a live event in a
 * test deployment.
 */

const stripeState = { accounts: new Map<string, Stripe.Account>() };

vi.mock("@/lib/payments/stripe", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments/stripe")>("@/lib/payments/stripe");
  return {
    ...actual,
    requireStripe: () =>
      ({
        accounts: {
          retrieve: async (id: string) => {
            const found = stripeState.accounts.get(id);
            if (!found) throw new Error(`no such account ${id}`);
            return found;
          },
        },
      }) as never,
  };
});

const { processConnectEvent } = await import("@/db/repositories/admin/stripe-connect-webhooks");

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let globex: SeededTenant;

const ACME_ACCOUNT = "acct_acme";
const GLOBEX_ACCOUNT = "acct_globex";

function account(id: string, chargesEnabled: boolean): Stripe.Account {
  return { id, object: "account", charges_enabled: chargesEnabled, details_submitted: true, payouts_enabled: chargesEnabled } as Stripe.Account;
}

function accountUpdated(accountId: string, payloadCharges: boolean, overrides: Partial<Stripe.Event> = {}): Stripe.Event {
  return {
    id: `evt_${newPublicId()}`,
    object: "event",
    type: "account.updated",
    account: accountId,
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    api_version: "2026-08-26.dahlia",
    pending_webhooks: 1,
    request: null,
    data: { object: { id: accountId, object: "account", charges_enabled: payloadCharges } as never },
    ...overrides,
  } as Stripe.Event;
}

async function shopFor(tenant: SeededTenant) {
  const [row] = await db
    .select({ chargesEnabled: shopSettings.chargesEnabled })
    .from(shopSettings)
    .where(eq(shopSettings.organizationId, tenant.organizationId));
  return row!;
}

async function seedShop(tenant: SeededTenant, stripeAccountId: string) {
  const [site] = await db
    .insert(sites)
    .values({ publicId: newPublicId(), organizationId: tenant.organizationId, name: `site-${newPublicId().slice(0, 6)}` })
    .returning({ id: sites.id });
  await db.insert(shopSettings).values({ organizationId: tenant.organizationId, siteId: site!.id, stripeAccountId });
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  acme = await seedTenant(db, "Acme");
  globex = await seedTenant(db, "Globex");
  await seedShop(acme, ACME_ACCOUNT);
  await seedShop(globex, GLOBEX_ACCOUNT);
});

afterAll(async () => {
  await close();
});

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_shop");
  stripeState.accounts.set(ACME_ACCOUNT, account(ACME_ACCOUNT, false));
  stripeState.accounts.set(GLOBEX_ACCOUNT, account(GLOBEX_ACCOUNT, false));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("account.updated", () => {
  it("mirrors what Stripe says now, not what the payload said then", async () => {
    // The payload claims charges are on; Stripe, asked now, says they are not.
    const outcome = await processConnectEvent(db, accountUpdated(ACME_ACCOUNT, true));
    expect(outcome.status).toBe("processed");
    expect((await shopFor(acme)).chargesEnabled).toBe(false);

    stripeState.accounts.set(ACME_ACCOUNT, account(ACME_ACCOUNT, true));
    await processConnectEvent(db, accountUpdated(ACME_ACCOUNT, false));
    expect((await shopFor(acme)).chargesEnabled).toBe(true);
  });

  it("touches only the shop that uses the account", async () => {
    expect((await shopFor(globex)).chargesEnabled).toBe(false);
    stripeState.accounts.set(GLOBEX_ACCOUNT, account(GLOBEX_ACCOUNT, true));
    await processConnectEvent(db, accountUpdated(GLOBEX_ACCOUNT, true));
    expect((await shopFor(globex)).chargesEnabled).toBe(true);
    expect((await shopFor(acme)).chargesEnabled).toBe(true);
  });

  it("can switch a shop off again", async () => {
    stripeState.accounts.set(ACME_ACCOUNT, account(ACME_ACCOUNT, false));
    await processConnectEvent(db, accountUpdated(ACME_ACCOUNT, true));
    expect((await shopFor(acme)).chargesEnabled).toBe(false);
  });

  it("matches an account nobody connected to no shop at all", async () => {
    stripeState.accounts.set("acct_stranger", account("acct_stranger", true));
    const outcome = await processConnectEvent(db, accountUpdated("acct_stranger", true));
    expect(outcome).toMatchObject({ status: "unmatched" });
  });

  it("processes an event once", async () => {
    const event = accountUpdated(ACME_ACCOUNT, false);
    expect((await processConnectEvent(db, event)).status).toBe("processed");
    expect((await processConnectEvent(db, event)).status).toBe("duplicate");

    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.provider, "stripe-connect"), eq(webhookDeliveries.deliveryId, event.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("processed");
  });

  it("leaves a failed delivery open for Stripe's retry", async () => {
    const event = accountUpdated("acct_missing", true); // retrieve throws: nothing in the fake API
    await expect(processConnectEvent(db, event)).rejects.toThrow();
    const [row] = await db
      .select({ status: webhookDeliveries.status })
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.provider, "stripe-connect"), eq(webhookDeliveries.deliveryId, event.id)));
    expect(row!.status).toBe("failed");

    stripeState.accounts.set("acct_missing", account("acct_missing", true));
    expect((await processConnectEvent(db, event)).status).toBe("unmatched");
  });
});

describe("what is not processed", () => {
  it("drops an event from the other Stripe mode", async () => {
    stripeState.accounts.set(ACME_ACCOUNT, account(ACME_ACCOUNT, true));
    const outcome = await processConnectEvent(db, accountUpdated(ACME_ACCOUNT, true, { livemode: true }));
    expect(outcome).toMatchObject({ status: "ignored" });
    expect((await shopFor(acme)).chargesEnabled).toBe(false);
  });

  it("acknowledges an event type it does not handle without claiming it", async () => {
    const event = accountUpdated(ACME_ACCOUNT, true, { type: "account.application.deauthorized" as never });
    expect(await processConnectEvent(db, event)).toMatchObject({ status: "ignored" });
    const rows = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.deliveryId, event.id));
    expect(rows).toHaveLength(0);
  });

  it("matches an event about no account to nothing", async () => {
    const event = accountUpdated(ACME_ACCOUNT, true, { account: undefined, data: { object: { id: "ch_1", object: "charge" } as never } });
    expect(connectedAccountIdOf(event)).toBeNull();
    expect(await processConnectEvent(db, event)).toMatchObject({ status: "unmatched" });
  });

  it("reads the account off the object when the header is missing", () => {
    const event = accountUpdated(ACME_ACCOUNT, true, { account: undefined });
    expect(connectedAccountIdOf(event)).toBe(ACME_ACCOUNT);
  });
});
