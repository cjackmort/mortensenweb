import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  adCampaignChannels,
  adCampaigns,
  adStatsDaily,
  auditLog,
  paymentAdjustments,
  paymentRequests,
  payments,
  users,
} from "@/db/schema";
import { adminContextFrom, NotFoundError, type AdminContext } from "@/db/repositories/context";
import { newPublicId } from "@/lib/ids";
import type { AdStatRow } from "@/lib/ads/stats";
import { AdsApiError } from "@/lib/ads/stats";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * The operator's side of a campaign: check it, launch it, watch it, settle it.
 *
 * What this protects:
 *  - a rejection reaching the client without the reason
 *  - a campaign going live with a channel nobody linked
 *  - a client losing days because review took longer than their start date
 *  - figures from a revised day being added to rather than replaced
 *  - a refund sent twice, or computed from spend nobody measured
 *  - one client's results showing on another client's page
 */

let db: Database;
let close: () => Promise<void>;
let admin: AdminContext;
let acme: SeededTenant;
let globex: SeededTenant;

const sent: Array<{ to: string; subject: string; text: string }> = [];
vi.mock("@/lib/email/mailer", () => ({
  sendEmail: vi.fn(async (message: { to: string; subject: string; text: string }) => {
    sent.push(message);
    return { status: "sent", id: "test" };
  }),
}));

const refunds: Array<{ params: Record<string, unknown>; options: Record<string, unknown> }> = [];
vi.mock("@/lib/payments/stripe", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments/stripe")>("@/lib/payments/stripe");
  return {
    ...actual,
    requireStripe: () =>
      ({
        refunds: {
          create: async (params: Record<string, unknown>, options: Record<string, unknown>) => {
            refunds.push({ params, options });
            return { id: `re_${refunds.length}` };
          },
        },
        checkout: { sessions: { retrieve: async () => ({ payment_intent: "pi_from_session" }) } },
      }) as never,
  };
});

const { reviewCampaign, getAdminCampaign, listAdminCampaigns, adsOverview } = await import("@/db/repositories/admin/ads");
const { recordChannelLaunch, markCampaignLive, changeCampaignState } = await import("@/db/repositories/admin/ad-launch");
const { settleAndRefund, previewSettlement } = await import("@/db/repositories/admin/ad-refund");
const { runScheduledAdSync, syncCampaignNow, endFinishedCampaigns } = await import("@/db/repositories/admin/ad-sync");
const { getCampaignResults } = await import("@/db/repositories/client/ad-report");

const GOOGLE_ENV = {
  GOOGLE_ADS_DEVELOPER_TOKEN: "d",
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: "1112223333",
  GOOGLE_ADS_CLIENT_ID: "c",
  GOOGLE_ADS_CLIENT_SECRET: "s",
  GOOGLE_ADS_REFRESH_TOKEN: "r",
};
const NOW = new Date("2026-10-20T18:00:00Z");

function totalRow(day: string, over: Partial<AdStatRow> = {}): AdStatRow {
  return { day, dimension: "total", value: "", impressions: 100, clicks: 5, costMicros: 2_500_000, calls: 1, leads: 0, conversions: 1, ...over };
}

/** A campaign paid by card and waiting for review, as checkout leaves one. */
async function paidCampaign(
  tenant: SeededTenant,
  { channels = ["google_search", "instagram"], provider = "stripe" }: { channels?: string[]; provider?: string } = {},
) {
  const [payment] = await db
    .insert(payments)
    .values({
      publicId: newPublicId(),
      clientId: tenant.clientId,
      amountCents: 51750,
      method: provider === "stripe" ? "stripe" : "venmo",
      provider: provider === "stripe" ? "stripe" : null,
      providerReference: provider === "stripe" ? "pi_paid" : null,
      receivedOn: "2026-10-12",
    })
    .returning();
  const [request] = await db
    .insert(paymentRequests)
    .values({
      publicId: newPublicId(),
      clientId: tenant.clientId,
      reference: `MW-${newPublicId().slice(0, 6)}`,
      amountCents: 51750,
      status: "paid",
      confirmedAt: new Date(),
      confirmedByUserId: admin.userId,
      paymentId: payment!.id,
      purpose: "other",
    })
    .returning();
  const publicId = newPublicId();
  const [campaign] = await db
    .insert(adCampaigns)
    .values({
      publicId,
      organizationId: tenant.organizationId,
      clientId: tenant.clientId,
      name: "Drain cleaning ad",
      status: "pending_review",
      headlines: ["Acme Plumbing", "Drain Cleaning in Riverton", "Call Today"],
      descriptions: ["Drain cleaning in Riverton.", "Call Acme Plumbing today."],
      callToAction: "call",
      finalUrl: "https://acme.example",
      targetAreas: ["Riverton"],
      startsOn: "2026-10-14",
      endsOn: "2026-11-12",
      paymentRequestId: request!.id,
      spendBudgetCents: 45000,
      managementFeeCents: 6750,
      feeBasisPoints: 1500,
      feeMinimumCents: 2500,
      paidAt: new Date("2026-10-12T12:00:00Z"),
    })
    .returning();
  const budgets: Record<string, number> = { google_search: 30000, instagram: 15000, facebook: 15000 };
  await db.insert(adCampaignChannels).values(
    channels.map((channel) => ({
      campaignId: campaign!.id,
      channel,
      platform: channel.startsWith("google") ? "google_ads" : "meta",
      budgetCents: budgets[channel]!,
    })),
  );
  return { publicId, id: campaign!.id, paymentId: payment!.id };
}

async function launch(publicId: string) {
  await reviewCampaign(admin, db, publicId, { approve: true, note: "" });
  await recordChannelLaunch(admin, db, publicId, { channel: "google_search", accountId: "444-555-6666", campaignId: "987654321" });
  await recordChannelLaunch(admin, db, publicId, { channel: "instagram", accountId: "act_1234567", campaignId: "120200000001" });
  await markCampaignLive(admin, db, publicId, { now: new Date("2026-10-14T16:00:00Z") });
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const [user] = await db
    .insert(users)
    .values({ publicId: newPublicId(), email: "operator@example.test", role: "admin", status: "active" })
    .returning();
  admin = adminContextFrom({ userId: user!.id, organizationId: null, role: "admin", status: "active", sessionEpoch: 0 });
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  sent.length = 0;
  refunds.length = 0;
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  acme = await seedTenant(db, "Acme Plumbing");
  globex = await seedTenant(db, "Globex");
});

describe("review", () => {
  it("approves a paid campaign for launch", async () => {
    const { publicId } = await paidCampaign(acme);
    expect(await reviewCampaign(admin, db, publicId, { approve: true, note: "" })).toEqual({ ok: true });
    expect((await getAdminCampaign(admin, db, publicId)).status).toBe("approved");
  });

  it("refuses to reject without saying why, and sends the reason when it does", async () => {
    const { publicId } = await paidCampaign(acme);
    expect(await reviewCampaign(admin, db, publicId, { approve: false, note: "  " })).toMatchObject({ ok: false });

    await reviewCampaign(admin, db, publicId, { approve: false, note: "Google won't accept 'Call Today' twice." });
    const campaign = await getAdminCampaign(admin, db, publicId);
    expect(campaign).toMatchObject({ status: "rejected", reviewNote: "Google won't accept 'Call Today' twice." });
    expect(sent).toHaveLength(1);
    // No contact on the client record, so it goes to the organisation's owner.
    expect(sent[0]!.to).toMatch(/^acme-plumbing-.+@example\.test$/);
    expect(sent[0]!.text).toContain("Google won't accept 'Call Today' twice.");
  });

  it("decides a campaign once", async () => {
    const { publicId } = await paidCampaign(acme);
    await reviewCampaign(admin, db, publicId, { approve: true, note: "" });
    expect(await reviewCampaign(admin, db, publicId, { approve: false, note: "no" })).toMatchObject({ ok: false });
  });

  it("lists claims the business never made, for the policy check", async () => {
    const { publicId, id } = await paidCampaign(acme);
    await db.update(adCampaigns).set({ headlines: ["Licensed Plumbers", "Best in Riverton", "Call Today"] }).where(eq(adCampaigns.id, id));
    const campaign = await getAdminCampaign(admin, db, publicId);
    expect(campaign.policy.claims).toEqual(expect.arrayContaining(["licensed", "best"]));
  });
});

describe("launching by hand", () => {
  it("will not go live until every channel has its platform ids", async () => {
    const { publicId } = await paidCampaign(acme);
    await reviewCampaign(admin, db, publicId, { approve: true, note: "" });
    await recordChannelLaunch(admin, db, publicId, { channel: "google_search", accountId: "444-555-6666", campaignId: "987654321" });

    expect(await markCampaignLive(admin, db, publicId, { now: NOW })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/instagram/),
    });
  });

  it("refuses an id that is not digits, which the sync would put in a query", async () => {
    const { publicId } = await paidCampaign(acme);
    await reviewCampaign(admin, db, publicId, { approve: true, note: "" });
    expect(
      await recordChannelLaunch(admin, db, publicId, { channel: "google_search", accountId: "4445556666", campaignId: "1 OR 1=1" }),
    ).toMatchObject({ ok: false });
  });

  it("normalises the account ids each platform uses", async () => {
    const { publicId } = await paidCampaign(acme);
    await reviewCampaign(admin, db, publicId, { approve: true, note: "" });
    await recordChannelLaunch(admin, db, publicId, { channel: "google_search", accountId: "444-555-6666", campaignId: "987654321" });
    await recordChannelLaunch(admin, db, publicId, { channel: "instagram", accountId: "1234567", campaignId: "120200000001" });

    const { channels } = await getAdminCampaign(admin, db, publicId);
    expect(channels.map((c) => [c.channel, c.externalAccountId, c.launchMode])).toEqual([
      ["google_search", "4445556666", "manual"],
      ["instagram", "act_1234567", "manual"],
    ]);
  });

  it("refuses to launch an ad nobody approved", async () => {
    const { publicId } = await paidCampaign(acme);
    expect(
      await recordChannelLaunch(admin, db, publicId, { channel: "google_search", accountId: "4445556666", campaignId: "987654321" }),
    ).toMatchObject({ ok: false });
  });

  it("moves both dates when review ran past the start, so no paid day is lost", async () => {
    const { publicId } = await paidCampaign(acme);
    await reviewCampaign(admin, db, publicId, { approve: true, note: "" });
    await recordChannelLaunch(admin, db, publicId, { channel: "google_search", accountId: "4445556666", campaignId: "987654321" });
    await recordChannelLaunch(admin, db, publicId, { channel: "instagram", accountId: "act_1234567", campaignId: "120200000001" });

    expect(await markCampaignLive(admin, db, publicId, { now: NOW })).toEqual({ ok: true });
    const campaign = await getAdminCampaign(admin, db, publicId);
    expect(campaign).toMatchObject({ status: "active", startsOn: "2026-10-20", endsOn: "2026-11-18" });
    expect(sent.at(-1)!.subject).toMatch(/live/);
  });
});

describe("pausing, ending, cancelling", () => {
  it("follows the allowed moves only", async () => {
    const { publicId } = await paidCampaign(acme);
    expect(await changeCampaignState(admin, db, publicId, "pause")).toMatchObject({ ok: false });
    await launch(publicId);

    expect(await changeCampaignState(admin, db, publicId, "pause")).toEqual({ ok: true });
    expect(await changeCampaignState(admin, db, publicId, "cancel")).toMatchObject({ ok: false });
    expect(await changeCampaignState(admin, db, publicId, "resume")).toEqual({ ok: true });
    expect(await changeCampaignState(admin, db, publicId, "end")).toEqual({ ok: true });
    expect((await getAdminCampaign(admin, db, publicId)).channels.every((c) => c.status === "ended")).toBe(true);
  });

  it("ends a campaign on its own once its last day has passed", async () => {
    const { publicId } = await paidCampaign(acme);
    await launch(publicId);
    expect(await endFinishedCampaigns(db, { now: new Date("2026-11-14T18:00:00Z") })).toBeGreaterThanOrEqual(1);
    expect((await getAdminCampaign(admin, db, publicId)).status).toBe("ended");
  });
});

describe("the stats sync", () => {
  it("does nothing but end campaigns when no platform is connected", async () => {
    const outcome = await runScheduledAdSync(db, { now: NOW, env: {} });
    expect(outcome).toMatchObject({ ran: false, reason: "not_configured" });
  });

  it("writes each day and breakdown, and the channel's spend", async () => {
    const { publicId } = await paidCampaign(acme);
    await launch(publicId);
    const google = vi.fn(async () => [
      totalRow("2026-10-14"),
      totalRow("2026-10-15", { costMicros: 3_000_000 }),
      { ...totalRow("2026-10-15"), dimension: "placement" as const, value: "google_maps" },
      { ...totalRow("2026-10-15"), dimension: "location" as const, value: "Riverton, Utah" },
    ]);
    const meta = vi.fn(async () => [totalRow("2026-10-15", { impressions: 900, costMicros: 4_000_000 })]);

    const results = await syncCampaignNow(db, publicId, { now: NOW, env: { ...GOOGLE_ENV, META_SYSTEM_USER_TOKEN: "t", META_APP_SECRET: "s" }, fetchers: { google, meta } });
    expect(results).toEqual([
      { ok: true, rows: 4 },
      { ok: true, rows: 1 },
    ]);
    expect(google).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "4445556666", campaignId: "987654321", from: "2026-10-14", to: "2026-10-20" }),
    );

    const { channels } = await getAdminCampaign(admin, db, publicId);
    expect(channels.find((c) => c.channel === "google_search")).toMatchObject({ spendMicros: 5_500_000, syncError: null });
    expect(channels.find((c) => c.channel === "instagram")).toMatchObject({ spendMicros: 4_000_000 });
  });

  it("replaces a revised day rather than adding to it", async () => {
    const { publicId, id } = await paidCampaign(acme, { channels: ["google_search"] });
    await reviewCampaign(admin, db, publicId, { approve: true, note: "" });
    await recordChannelLaunch(admin, db, publicId, { channel: "google_search", accountId: "4445556666", campaignId: "987654321" });
    await markCampaignLive(admin, db, publicId, { now: new Date("2026-10-14T16:00:00Z") });

    const first = vi.fn(async () => [
      totalRow("2026-10-19"),
      { ...totalRow("2026-10-19"), dimension: "placement" as const, value: "display_network" },
    ]);
    await syncCampaignNow(db, publicId, { now: NOW, env: GOOGLE_ENV, fetchers: { google: first, meta: vi.fn() } });
    const second = vi.fn(async () => [totalRow("2026-10-19", { clicks: 7 })]);
    await syncCampaignNow(db, publicId, { now: NOW, env: GOOGLE_ENV, fetchers: { google: second, meta: vi.fn() } });

    // The second sync re-reads only the last week, not the whole campaign.
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ from: "2026-10-14", to: "2026-10-20" }));
    const rows = await db.select().from(adStatsDaily).where(eq(adStatsDaily.campaignId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dimension: "total", clicks: 7 });
  });

  it("records a platform's refusal for the operator and keeps the old figures", async () => {
    const { publicId } = await paidCampaign(acme, { channels: ["google_search"] });
    await reviewCampaign(admin, db, publicId, { approve: true, note: "" });
    await recordChannelLaunch(admin, db, publicId, { channel: "google_search", accountId: "4445556666", campaignId: "987654321" });
    await markCampaignLive(admin, db, publicId, { now: NOW });

    const failing = vi.fn(async () => {
      throw new AdsApiError("google_ads", "auth", "Token has been expired or revoked.");
    });
    const results = await syncCampaignNow(db, publicId, { now: NOW, env: GOOGLE_ENV, fetchers: { google: failing, meta: vi.fn() } });
    expect(results[0]).toMatchObject({ ok: false, reason: "failed" });
    const { channels } = await getAdminCampaign(admin, db, publicId);
    expect(channels[0]!.syncError).toMatch(/revoked/);
  });

  it("runs at most every six hours on the scheduler", async () => {
    const { publicId } = await paidCampaign(acme, { channels: ["google_search"] });
    await reviewCampaign(admin, db, publicId, { approve: true, note: "" });
    await recordChannelLaunch(admin, db, publicId, { channel: "google_search", accountId: "4445556666", campaignId: "987654321" });
    await markCampaignLive(admin, db, publicId, { now: NOW });
    await db.delete(auditLog).where(eq(auditLog.action, "ads.synced"));

    const google = vi.fn(async () => [totalRow("2026-10-20")]);
    const first = await runScheduledAdSync(db, { now: NOW, env: GOOGLE_ENV, fetchers: { google, meta: vi.fn() } });
    expect(first).toMatchObject({ ran: true });
    const second = await runScheduledAdSync(db, { now: new Date(NOW.getTime() + 60_000), env: GOOGLE_ENV, fetchers: { google, meta: vi.fn() } });
    expect(second).toMatchObject({ ran: false, reason: "too_soon" });
  });
});

describe("settling", () => {
  it("will not settle a campaign that is still running", async () => {
    const { publicId } = await paidCampaign(acme);
    await launch(publicId);
    expect(await settleAndRefund(admin, db, publicId)).toMatchObject({ ok: false, message: expect.stringMatching(/End/) });
  });

  it("needs the operator's final spend when nothing has synced", async () => {
    const { publicId } = await paidCampaign(acme);
    await launch(publicId);
    await changeCampaignState(admin, db, publicId, "end");
    expect(await settleAndRefund(admin, db, publicId)).toMatchObject({ ok: false, message: expect.stringMatching(/final spend/) });
  });

  it("refunds the unspent budget and the fee on it through Stripe, once", async () => {
    const { publicId, paymentId } = await paidCampaign(acme);
    await launch(publicId);
    await changeCampaignState(admin, db, publicId, "end");

    // $300 of $450 spent: fee 15% of $300 = $45, against $67.50 paid.
    expect(await previewSettlement(admin, db, publicId, { finalSpendCents: 30000 })).toMatchObject({
      settlement: { keptSpendCents: 30000, keptFeeCents: 4500, refundCents: 15000 + 2250 },
    });

    const outcome = await settleAndRefund(admin, db, publicId, { finalSpendCents: 30000 });
    expect(outcome).toMatchObject({ ok: true, refundReference: "re_1" });
    expect(refunds[0]).toMatchObject({
      params: { payment_intent: "pi_paid", amount: 17250 },
      options: { idempotencyKey: `ad_refund:${publicId}:0` },
    });

    const [adjustment] = await db.select().from(paymentAdjustments).where(eq(paymentAdjustments.paymentId, paymentId));
    expect(adjustment).toMatchObject({ kind: "refund", amountCentsDelta: -17250 });
    expect(sent.at(-1)!.subject).toMatch(/\$172\.50/);

    expect(await settleAndRefund(admin, db, publicId, { finalSpendCents: 30000 })).toMatchObject({ ok: false });
    expect(refunds).toHaveLength(1);
  });

  it("settles on the synced spend when every channel has reported", async () => {
    const { publicId } = await paidCampaign(acme, { channels: ["google_search"] });
    await reviewCampaign(admin, db, publicId, { approve: true, note: "" });
    await recordChannelLaunch(admin, db, publicId, { channel: "google_search", accountId: "4445556666", campaignId: "987654321" });
    await markCampaignLive(admin, db, publicId, { now: new Date("2026-10-14T16:00:00Z") });
    await syncCampaignNow(db, publicId, {
      now: NOW,
      env: GOOGLE_ENV,
      fetchers: { google: vi.fn(async () => [totalRow("2026-10-15", { costMicros: 100_000_000 })]), meta: vi.fn() },
    });
    await changeCampaignState(admin, db, publicId, "end");

    const outcome = await settleAndRefund(admin, db, publicId);
    // $100 of $450 spent; fee max(15% of $100, $25) = $25.
    expect(outcome).toMatchObject({ ok: true, settlement: { keptSpendCents: 10000, keptFeeCents: 2500 } });
  });

  it("gives everything back, fee included, for a campaign cancelled before it ran", async () => {
    const { publicId } = await paidCampaign(acme);
    await reviewCampaign(admin, db, publicId, { approve: false, note: "We can't advertise this service." });
    await changeCampaignState(admin, db, publicId, "cancel");

    const outcome = await settleAndRefund(admin, db, publicId);
    expect(outcome).toMatchObject({ ok: true, settlement: { refundCents: 51750 } });
    expect(refunds[0]!.params).toMatchObject({ amount: 51750 });
  });

  it("asks the operator to pay back a non-card payment by hand", async () => {
    const { publicId } = await paidCampaign(acme, { provider: "venmo" });
    await changeCampaignState(admin, db, publicId, "cancel");
    expect(await settleAndRefund(admin, db, publicId)).toMatchObject({ ok: false, message: expect.stringMatching(/by hand/) });
    expect(await settleAndRefund(admin, db, publicId, { refundedByHand: true })).toMatchObject({ ok: true });
    expect(refunds).toHaveLength(0);
  });
});

describe("the overview", () => {
  it("counts paid spend, fees kept and refunds due", async () => {
    const running = await paidCampaign(acme);
    await launch(running.publicId);
    const cancelled = await paidCampaign(globex);
    await changeCampaignState(admin, db, cancelled.publicId, "cancel");

    const rows = (await listAdminCampaigns(admin, db)).filter((r) =>
      [running.publicId, cancelled.publicId].includes(r.publicId),
    );
    const overview = adsOverview(rows);
    expect(overview).toMatchObject({
      paidSpendCents: 90000,
      // Only the campaign that ran earns its fee.
      feeRevenueCents: 6750,
      activeCampaigns: 1,
      refundsDue: 1,
    });
  });
});

describe("the client's report", () => {
  it("says a running campaign is not connected rather than showing zeros", async () => {
    const { publicId } = await paidCampaign(acme);
    await launch(publicId);
    const results = await getCampaignResults(db, acme.ctx, publicId, { now: NOW, env: {} });
    expect(results.state).toBe("not_connected");
    expect(results.report.totals.ctr).toBeNull();
  });

  it("is waiting, not empty, between connecting and the first figures", async () => {
    const { publicId } = await paidCampaign(acme);
    await launch(publicId);
    const results = await getCampaignResults(db, acme.ctx, publicId, { now: NOW, env: GOOGLE_ENV });
    expect(results.state).toBe("waiting");
  });

  it("reports once figures exist, and never to another client", async () => {
    const { publicId } = await paidCampaign(acme, { channels: ["google_search"] });
    await reviewCampaign(admin, db, publicId, { approve: true, note: "" });
    await recordChannelLaunch(admin, db, publicId, { channel: "google_search", accountId: "4445556666", campaignId: "987654321" });
    await markCampaignLive(admin, db, publicId, { now: new Date("2026-10-14T16:00:00Z") });
    await syncCampaignNow(db, publicId, {
      now: NOW,
      env: GOOGLE_ENV,
      fetchers: { google: vi.fn(async () => [totalRow("2026-10-15"), totalRow("2026-10-17")]), meta: vi.fn() },
    });

    const results = await getCampaignResults(db, acme.ctx, publicId, { now: NOW, env: GOOGLE_ENV });
    expect(results.state).toBe("reporting");
    expect(results.report.totals).toMatchObject({ impressions: 200, clicks: 10, ctr: 0.05 });
    expect(results.report.daily.map((d) => d.day)).toEqual([
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
      "2026-10-19",
      "2026-10-20",
    ]);

    await expect(getCampaignResults(db, globex.ctx, publicId, { now: NOW, env: GOOGLE_ENV })).rejects.toBeInstanceOf(NotFoundError);
  });
});
