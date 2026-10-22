import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import type { Database } from "@/db/client";
import {
  adCampaignChannels,
  adCampaigns,
  businessProfiles,
  mediaAssets,
  paymentRequests,
  sites,
  users,
} from "@/db/schema";
import { NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * A client's ad campaign, from "Create ad" to the money arriving.
 *
 * The failures worth a test are the ones that cost somebody money or trust:
 *  - reaching another client's campaign or photos
 *  - paying for an ad whose words or budgets break the rules
 *  - the fee hidden in the spend instead of on its own Stripe line
 *  - a stale checkout tab paying for an ad that has since changed
 *  - money arriving and the campaign never reaching review
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let globex: SeededTenant;

interface FakeSession {
  id: string;
  object: "checkout.session";
  url: string | null;
  status: "open" | "complete" | "expired";
  mode: "payment";
  payment_status: "paid" | "unpaid";
  amount_total: number;
  currency: string;
  customer: string;
  metadata: Record<string, string>;
  payment_intent: unknown;
  subscription: null;
  livemode: boolean;
  line_items: Stripe.Checkout.SessionCreateParams.LineItem[];
}

const fake = {
  sessions: new Map<string, FakeSession>(),
  created: [] as Stripe.Checkout.SessionCreateParams[],
  expired: [] as string[],
  counter: 0,
};

vi.mock("@/lib/payments/stripe", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments/stripe")>("@/lib/payments/stripe");
  return {
    ...actual,
    requireStripe: () =>
      ({
        customers: {
          create: async () => ({ id: `cus_fake_${Math.random().toString(36).slice(2)}` }),
          retrieve: async () => ({ deleted: true }),
        },
        checkout: {
          sessions: {
            create: async (params: Stripe.Checkout.SessionCreateParams) => {
              fake.created.push(params);
              fake.counter += 1;
              const lines = params.line_items ?? [];
              const session: FakeSession = {
                id: `cs_test_${fake.counter}`,
                object: "checkout.session",
                url: `https://checkout.stripe.test/${fake.counter}`,
                status: "open",
                mode: "payment",
                payment_status: "unpaid",
                amount_total: lines.reduce((sum, l) => sum + (l.price_data?.unit_amount ?? 0), 0),
                currency: "usd",
                customer: String(params.customer),
                metadata: (params.metadata ?? {}) as Record<string, string>,
                payment_intent: null,
                subscription: null,
                livemode: false,
                line_items: lines,
              };
              fake.sessions.set(session.id, session);
              return session;
            },
            retrieve: async (id: string) => {
              const found = fake.sessions.get(id);
              if (!found) throw new Error(`no such session ${id}`);
              return found;
            },
            expire: async (id: string) => {
              const found = fake.sessions.get(id)!;
              found.status = "expired";
              fake.expired.push(id);
              return found;
            },
          },
        },
      }) as never,
  };
});

const { createDraftCampaign, discardDraft, getCampaign, listCampaigns, saveChannels, saveCreative } = await import(
  "@/db/repositories/client/ads"
);
const { beginAdCheckout, reopenCampaign } = await import("@/db/repositories/client/ad-checkout");
const { processStripeEvent } = await import("@/db/repositories/admin/stripe-webhooks");

const URLS = { successUrl: "https://portal.test/ok", cancelUrl: "https://portal.test/back" };
const NOW = new Date("2026-10-20T15:00:00Z");

async function addPhoto(tenant: SeededTenant, values: Partial<typeof mediaAssets.$inferInsert> = {}) {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      publicId: newPublicId(),
      organizationId: tenant.organizationId,
      originalFilename: "crew.jpg",
      status: "ready",
      storageKey: `media/${newPublicId()}`,
      contentType: "image/jpeg",
      byteSize: 1000,
      checksumSha256: "0".repeat(64),
      width: 1600,
      height: 900,
      title: "Crew",
      ...values,
    })
    .returning();
  return row!;
}

async function readyCampaign(tenant: SeededTenant) {
  const { publicId } = await createDraftCampaign(db, tenant.ctx);
  await saveChannels(
    db,
    tenant.ctx,
    publicId,
    {
      channels: [
        { channel: "google_search", budgetCents: 30000 },
        { channel: "instagram", budgetCents: 15000 },
      ],
      days: 30,
      startsOn: "2026-10-25",
    },
    { now: NOW },
  );
  return publicId;
}

function completeSession(id: string) {
  const session = fake.sessions.get(id)!;
  session.status = "complete";
  session.payment_status = "paid";
  session.payment_intent = { id: `pi_for_${id}`, latest_charge: { id: `ch_${id}`, receipt_url: null } };
  return session;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  // The webhook records confirmations as the first admin.
  await db.insert(users).values({ publicId: newPublicId(), email: "admin@example.test", role: "admin", status: "active" });
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  fake.sessions.clear();
  fake.created.length = 0;
  fake.expired.length = 0;
  fake.counter = 0;

  acme = await seedTenant(db, "Acme Plumbing");
  globex = await seedTenant(db, "Globex");
  await db.insert(businessProfiles).values({
    organizationId: acme.organizationId,
    details: {
      businessName: "Acme Plumbing",
      services: "Drain cleaning\nLeak repair",
      serviceArea: "Riverton, Herriman",
      phone: "(801) 555-0134",
    },
  });
  await db.insert(sites).values({
    publicId: newPublicId(),
    organizationId: acme.organizationId,
    name: "Acme",
    primaryDomain: "acmeplumbing.example",
  });
});

describe("createDraftCampaign", () => {
  it("drafts from the profile, the live site and the library", async () => {
    const photo = await addPhoto(acme);
    const { publicId } = await createDraftCampaign(db, acme.ctx);
    const campaign = await getCampaign(db, acme.ctx, publicId);

    expect(campaign.status).toBe("draft");
    expect(campaign.headlines[0]).toBe("Acme Plumbing");
    expect(campaign.headlines).toContain("Drain Cleaning in Riverton");
    expect(campaign.finalUrl).toBe("https://acmeplumbing.example");
    expect(campaign.phone).toBe("(801) 555-0134");
    expect(campaign.targetAreas).toEqual(["Riverton", "Herriman"]);
    expect(campaign.imageAssetPublicId).toBe(photo.publicId);
    expect(campaign.draftFacts?.services).toBe("Drain cleaning\nLeak repair");
  });

  it("never picks another client's photo", async () => {
    await addPhoto(globex);
    const { publicId } = await createDraftCampaign(db, acme.ctx);
    expect((await getCampaign(db, acme.ctx, publicId)).imageAssetPublicId).toBeNull();
  });

  it("drafts for a client with no profile at all, and says what is missing", async () => {
    const { publicId, missing } = await createDraftCampaign(db, globex.ctx);
    const campaign = await getCampaign(db, globex.ctx, publicId);
    expect(campaign.headlines[0]).toBe("Globex");
    expect(missing).toContain("services");
  });

  it("refuses a read-only session viewing as the client", async () => {
    const viewing = tenantContextFrom(
      { userId: acme.userId, organizationId: acme.organizationId, role: "admin", status: "active", sessionEpoch: 0 },
      acme.organizationId,
      { impersonating: true },
    );
    await expect(createDraftCampaign(db, viewing)).rejects.toThrow(/read-only/);
  });
});

describe("tenant isolation", () => {
  it("hides one client's campaign from another, as not found", async () => {
    const { publicId } = await createDraftCampaign(db, acme.ctx);

    await expect(getCampaign(db, globex.ctx, publicId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      saveCreative(db, globex.ctx, publicId, {
        name: "x",
        headlines: [],
        descriptions: [],
        callToAction: null,
        finalUrl: null,
        phone: null,
        targetAreas: [],
        imageAssetPublicId: null,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(beginAdCheckout(db, globex.ctx, publicId, URLS)).rejects.toBeInstanceOf(NotFoundError);
    expect(await listCampaigns(db, globex.ctx)).toEqual([]);
  });

  it("will not attach another client's photo", async () => {
    const theirs = await addPhoto(globex);
    const { publicId } = await createDraftCampaign(db, acme.ctx);
    const campaign = await getCampaign(db, acme.ctx, publicId);

    await saveCreative(db, acme.ctx, publicId, { ...campaign, imageAssetPublicId: theirs.publicId });
    expect((await getCampaign(db, acme.ctx, publicId)).imageAssetPublicId).toBeNull();
  });
});

describe("saveCreative", () => {
  it("saves an over-long headline and says what is wrong with it", async () => {
    const { publicId } = await createDraftCampaign(db, acme.ctx);
    const campaign = await getCampaign(db, acme.ctx, publicId);

    const outcome = await saveCreative(db, acme.ctx, publicId, {
      ...campaign,
      headlines: [...campaign.headlines.slice(0, 2), "A headline that is far too long for Google"],
    });

    expect(outcome).toMatchObject({ ok: true, problems: [expect.stringMatching(/30 characters/)] });
    expect((await getCampaign(db, acme.ctx, publicId)).headlines[2]).toBe("A headline that is far too long for Google");
  });
});

describe("saveChannels", () => {
  it("stores each channel's budget and the dates", async () => {
    const publicId = await readyCampaign(acme);
    const campaign = await getCampaign(db, acme.ctx, publicId);

    expect(campaign.channels.map((c) => [c.channel, c.budgetCents])).toEqual([
      ["google_search", 30000],
      ["instagram", 15000],
    ]);
    expect(campaign.spendBudgetCents).toBe(45000);
    expect(campaign.managementFeeCents).toBe(6750);
    expect(campaign.startsOn).toBe("2026-10-25");
    expect(campaign.endsOn).toBe("2026-11-23");
  });

  it("refuses a budget under the minimum", async () => {
    const { publicId } = await createDraftCampaign(db, acme.ctx);
    const outcome = await saveChannels(
      db,
      acme.ctx,
      publicId,
      { channels: [{ channel: "facebook", budgetCents: 2000 }], days: 30, startsOn: "2026-10-25" },
      { now: NOW },
    );
    expect(outcome).toMatchObject({ ok: false, errors: { facebook: expect.stringMatching(/\$150/) } });
  });

  it("refuses a start date in the past", async () => {
    const { publicId } = await createDraftCampaign(db, acme.ctx);
    const outcome = await saveChannels(
      db,
      acme.ctx,
      publicId,
      { channels: [{ channel: "facebook", budgetCents: 20000 }], days: 30, startsOn: "2026-10-01" },
      { now: NOW },
    );
    expect(outcome).toMatchObject({ ok: false, errors: { startsOn: expect.any(String) } });
  });

  it("replaces the channels rather than adding to them", async () => {
    const publicId = await readyCampaign(acme);
    await saveChannels(
      db,
      acme.ctx,
      publicId,
      { channels: [{ channel: "facebook", budgetCents: 20000 }], days: 14, startsOn: "2026-10-25" },
      { now: NOW },
    );
    const campaign = await getCampaign(db, acme.ctx, publicId);
    expect(campaign.channels.map((c) => c.channel)).toEqual(["facebook"]);
    expect(campaign.endsOn).toBe("2026-11-07");
  });
});

describe("beginAdCheckout", () => {
  it("charges each channel's spend and the management fee as separate lines", async () => {
    const publicId = await readyCampaign(acme);
    const outcome = await beginAdCheckout(db, acme.ctx, publicId, URLS);

    expect(outcome).toMatchObject({ ok: true, reused: false });
    const lines = fake.created[0]!.line_items!.map((l) => [l.price_data!.product_data!.name, l.price_data!.unit_amount]);
    expect(lines).toEqual([
      ["Ad spend: Google Search", 30000],
      ["Ad spend: Instagram", 15000],
      ["Management fee (15% of ad spend, $25 minimum)", 6750],
    ]);

    const campaign = await getCampaign(db, acme.ctx, publicId);
    expect(campaign.status).toBe("awaiting_payment");
    expect(campaign).toMatchObject({ feeBasisPoints: 1500, feeMinimumCents: 2500, managementFeeCents: 6750 });

    const [request] = await db.select().from(paymentRequests).where(eq(paymentRequests.clientId, acme.clientId));
    expect(request).toMatchObject({ amountCents: 51750, status: "open", providerReference: "cs_test_1" });
  });

  it("hands back the open checkout on a second click", async () => {
    const publicId = await readyCampaign(acme);
    const first = await beginAdCheckout(db, acme.ctx, publicId, URLS);
    const second = await beginAdCheckout(db, acme.ctx, publicId, URLS);

    expect(second).toMatchObject({ ok: true, reused: true });
    expect(second.ok && first.ok && second.url === first.url).toBe(true);
    expect(fake.created).toHaveLength(1);
  });

  it("refuses an ad that breaks the rules", async () => {
    const publicId = await readyCampaign(acme);
    const campaign = await getCampaign(db, acme.ctx, publicId);
    await saveCreative(db, acme.ctx, publicId, { ...campaign, headlines: ["Only one"] });

    expect(await beginAdCheckout(db, acme.ctx, publicId, URLS)).toMatchObject({ ok: false, reason: "not_ready" });
    expect(fake.created).toHaveLength(0);
  });

  it("refuses an ad with no channels chosen", async () => {
    const { publicId } = await createDraftCampaign(db, acme.ctx);
    expect(await beginAdCheckout(db, acme.ctx, publicId, URLS)).toMatchObject({ ok: false, reason: "not_ready" });
  });

  it("says so plainly when card payments are not set up", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const publicId = await readyCampaign(acme);
    expect(await beginAdCheckout(db, acme.ctx, publicId, URLS)).toMatchObject({ ok: false, reason: "not_configured" });
  });
});

describe("paying", () => {
  it("moves the campaign to review once Stripe says the money arrived", async () => {
    const publicId = await readyCampaign(acme);
    const outcome = await beginAdCheckout(db, acme.ctx, publicId, URLS);
    expect(outcome.ok).toBe(true);

    const session = completeSession("cs_test_1");
    await processStripeEvent(db, {
      id: `evt_${newPublicId()}`,
      object: "event",
      type: "checkout.session.completed",
      livemode: false,
      created: 0,
      data: { object: session },
    } as unknown as Stripe.Event);

    const campaign = await getCampaign(db, acme.ctx, publicId);
    expect(campaign.status).toBe("pending_review");
    expect(campaign.paidAt).not.toBeNull();

    const [request] = await db.select().from(paymentRequests).where(eq(paymentRequests.clientId, acme.clientId));
    expect(request!.status).toBe("paid");
  });

  it("leaves a campaign alone while its payment is still unpaid", async () => {
    const publicId = await readyCampaign(acme);
    await beginAdCheckout(db, acme.ctx, publicId, URLS);
    const session = fake.sessions.get("cs_test_1")!;
    session.status = "complete";

    await processStripeEvent(db, {
      id: `evt_${newPublicId()}`,
      object: "event",
      type: "checkout.session.completed",
      livemode: false,
      created: 0,
      data: { object: session },
    } as unknown as Stripe.Event);

    expect((await getCampaign(db, acme.ctx, publicId)).status).toBe("awaiting_payment");
  });
});

describe("reopenCampaign", () => {
  it("expires the checkout and cancels the invoice, so an old tab cannot pay", async () => {
    const publicId = await readyCampaign(acme);
    await beginAdCheckout(db, acme.ctx, publicId, URLS);

    expect(await reopenCampaign(db, acme.ctx, publicId)).toEqual({ ok: true });
    expect(fake.expired).toEqual(["cs_test_1"]);

    const campaign = await getCampaign(db, acme.ctx, publicId);
    expect(campaign.status).toBe("draft");
    const [request] = await db.select().from(paymentRequests).where(eq(paymentRequests.clientId, acme.clientId));
    expect(request!.status).toBe("cancelled");

    // And a fresh checkout is a fresh invoice.
    await beginAdCheckout(db, acme.ctx, publicId, URLS);
    expect(fake.created).toHaveLength(2);
  });

  it("refuses once the payment has gone through", async () => {
    const publicId = await readyCampaign(acme);
    await beginAdCheckout(db, acme.ctx, publicId, URLS);
    completeSession("cs_test_1");

    expect(await reopenCampaign(db, acme.ctx, publicId)).toMatchObject({ ok: false });
    expect((await getCampaign(db, acme.ctx, publicId)).status).toBe("awaiting_payment");
  });
});

describe("discardDraft", () => {
  it("deletes an unpaid draft and nothing else", async () => {
    const draft = await createDraftCampaign(db, acme.ctx);
    const paying = await readyCampaign(acme);
    await beginAdCheckout(db, acme.ctx, paying, URLS);

    expect(await discardDraft(db, acme.ctx, draft.publicId)).toBe(true);
    expect(await discardDraft(db, acme.ctx, paying)).toBe(false);
    expect(await discardDraft(db, globex.ctx, paying)).toBe(false);

    const left = await db.select({ publicId: adCampaigns.publicId }).from(adCampaigns).where(eq(adCampaigns.organizationId, acme.organizationId));
    expect(left.map((r) => r.publicId)).toEqual([paying]);
    const channels = await db.select().from(adCampaignChannels);
    expect(channels.length).toBeGreaterThan(0);
  });
});
