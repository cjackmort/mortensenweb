import { describe, expect, it } from "vitest";
import {
  AD_CHANNELS,
  AD_DURATIONS_DAYS,
  AD_MANAGEMENT_FEE,
  adChannel,
  channelMinimumCents,
  channelSuggestedCents,
  managementFeeCents,
} from "@mortensenweb/plans";
import { checkoutLines, settleCampaign, validateBudgets } from "@/lib/ads/money";

/**
 * The money rules for an ad campaign, which the client sees before paying and
 * the operator applies when it ends.
 *
 * What would cost somebody money or trust if it were wrong:
 *  - the fee hidden inside the ad spend instead of on its own line
 *  - a fee charged on a campaign that never ran
 *  - a client charged for spend beyond the budget they paid for
 *  - unspent budget kept instead of refunded
 */

describe("the management fee", () => {
  it("defaults to 15% of the ad spend with a $25 floor", () => {
    expect(AD_MANAGEMENT_FEE).toEqual({ basisPoints: 1500, minimumCents: 2500 });
  });

  it("is 15% of a large budget", () => {
    expect(managementFeeCents(60000)).toBe(9000);
  });

  it("is the $25 minimum on a small budget", () => {
    expect(managementFeeCents(10000)).toBe(2500);
  });

  it("rounds to the nearest cent", () => {
    expect(managementFeeCents(33333)).toBe(5000);
  });

  it("is nothing when there is no spend at all", () => {
    expect(managementFeeCents(0)).toBe(0);
  });

  it("uses the terms it is given, so a settled campaign keeps the fee it was sold at", () => {
    expect(managementFeeCents(60000, { basisPoints: 1000, minimumCents: 5000 })).toBe(6000);
  });
});

describe("channels", () => {
  it("covers Google Search, Maps, YouTube/Display, Facebook and Instagram", () => {
    expect(AD_CHANNELS.map((c) => c.key)).toEqual([
      "google_search",
      "google_maps",
      "youtube_display",
      "facebook",
      "instagram",
    ]);
    expect(adChannel("facebook").platform).toBe("meta");
    expect(adChannel("google_maps").platform).toBe("google_ads");
  });

  it("scales the minimum and the suggestion with how long the ad runs", () => {
    const search = adChannel("google_search");
    expect(channelMinimumCents(search, 30)).toBe(search.minimumDailyCents * 30);
    expect(channelSuggestedCents(search, 14)).toBe(search.suggestedDailyCents * 14);
  });

  it("never suggests less than the minimum", () => {
    for (const channel of AD_CHANNELS) {
      expect(channel.suggestedDailyCents).toBeGreaterThanOrEqual(channel.minimumDailyCents);
    }
  });

  it("offers each channel's own suggested duration", () => {
    for (const channel of AD_CHANNELS) {
      expect(AD_DURATIONS_DAYS).toContain(channel.suggestedDays);
    }
  });
});

describe("validateBudgets", () => {
  it("accepts budgets at or above each channel's minimum", () => {
    const result = validateBudgets([{ channel: "google_search", budgetCents: 15000 }], 30);
    expect(result).toEqual({ ok: true, spendCents: 15000 });
  });

  it("refuses a budget under the channel's minimum, saying what the minimum is", () => {
    const result = validateBudgets([{ channel: "facebook", budgetCents: 5000 }], 30);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.facebook).toMatch(/\$150/);
  });

  it("refuses no channels at all", () => {
    const result = validateBudgets([], 30);
    expect(result.ok).toBe(false);
  });

  it("refuses a duration that is not on offer", () => {
    const result = validateBudgets([{ channel: "google_search", budgetCents: 90000 }], 45);
    expect(result.ok).toBe(false);
  });

  it("refuses the same channel twice", () => {
    const result = validateBudgets(
      [
        { channel: "instagram", budgetCents: 20000 },
        { channel: "instagram", budgetCents: 20000 },
      ],
      30,
    );
    expect(result.ok).toBe(false);
  });
});

describe("checkoutLines", () => {
  it("lists each channel's spend and then the fee as its own line", () => {
    const lines = checkoutLines({
      channels: [
        { channel: "google_search", budgetCents: 30000 },
        { channel: "instagram", budgetCents: 15000 },
      ],
      terms: AD_MANAGEMENT_FEE,
    });

    expect(lines.items).toEqual([
      { kind: "spend", label: "Ad spend: Google Search", cents: 30000 },
      { kind: "spend", label: "Ad spend: Instagram", cents: 15000 },
      { kind: "fee", label: "Management fee (15% of ad spend, $25 minimum)", cents: 6750 },
    ]);
    expect(lines.spendCents).toBe(45000);
    expect(lines.feeCents).toBe(6750);
    expect(lines.totalCents).toBe(51750);
  });
});

describe("settleCampaign", () => {
  const paid = { spendCents: 40000, feeCents: 6000, terms: AD_MANAGEMENT_FEE };

  it("refunds everything, fee included, when the campaign never ran", () => {
    expect(settleCampaign({ ...paid, actualSpendCents: 0, launched: false })).toEqual({
      keptSpendCents: 0,
      keptFeeCents: 0,
      refundCents: 46000,
    });
  });

  it("keeps nothing back when the whole budget was spent", () => {
    expect(settleCampaign({ ...paid, actualSpendCents: 40000, launched: true })).toEqual({
      keptSpendCents: 40000,
      keptFeeCents: 6000,
      refundCents: 0,
    });
  });

  it("refunds the unspent budget and the fee on it", () => {
    // $250 of $400 spent: fee becomes 15% of $250 = $37.50.
    expect(settleCampaign({ ...paid, actualSpendCents: 25000, launched: true })).toEqual({
      keptSpendCents: 25000,
      keptFeeCents: 3750,
      refundCents: 15000 + 2250,
    });
  });

  it("keeps the $25 minimum on a campaign that ran but spent little", () => {
    expect(settleCampaign({ ...paid, actualSpendCents: 5000, launched: true })).toMatchObject({
      keptFeeCents: 2500,
    });
  });

  it("never charges for spend beyond the budget the client paid for", () => {
    expect(settleCampaign({ ...paid, actualSpendCents: 41500, launched: true })).toEqual({
      keptSpendCents: 40000,
      keptFeeCents: 6000,
      refundCents: 0,
    });
  });

  it("settles against the fee terms the campaign was sold at, not today's", () => {
    const sold = { spendCents: 40000, feeCents: 4000, terms: { basisPoints: 1000, minimumCents: 2500 } };
    expect(settleCampaign({ ...sold, actualSpendCents: 30000, launched: true })).toEqual({
      keptSpendCents: 30000,
      keptFeeCents: 3000,
      refundCents: 10000 + 1000,
    });
  });
});
