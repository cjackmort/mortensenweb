import { describe, expect, it } from "vitest";
import {
  anchorDayFor,
  billingDayFromAnchor,
  parseBillingDay,
  shiftedAnchor,
} from "@/lib/billing/billing-day";

/**
 * The day of the month a client pays.
 *
 * Kept to 1–28 because the subscriptions table is, and because a 31st does not
 * exist in most months: Stripe would quietly move it, and the day the
 * operator picked would stop being the day the client is charged.
 */

const at = (iso: string) => new Date(iso);
const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe("parseBillingDay", () => {
  it("accepts a whole day from 1 to 28", () => {
    expect(parseBillingDay("1")).toBe(1);
    expect(parseBillingDay("15")).toBe(15);
    expect(parseBillingDay("28")).toBe(28);
  });

  it("refuses days that do not exist in every month", () => {
    expect(parseBillingDay("29")).toBeNull();
    expect(parseBillingDay("31")).toBeNull();
  });

  it("refuses anything that is not a whole day", () => {
    expect(parseBillingDay("0")).toBeNull();
    expect(parseBillingDay("-3")).toBeNull();
    expect(parseBillingDay("2.5")).toBeNull();
    expect(parseBillingDay("")).toBeNull();
    expect(parseBillingDay("tuesday")).toBeNull();
    expect(parseBillingDay(null)).toBeNull();
  });
});

describe("anchorDayFor", () => {
  it("asks Stripe to anchor on the chosen day", () => {
    expect(anchorDayFor(15, at("2026-10-05T18:00:00Z"))).toBe(15);
  });

  it("asks for no anchor when the chosen day is today", () => {
    // A subscription started today already renews on today's date. Asking
    // Stripe to anchor on it as well would push the first full charge a month
    // out and bill nearly a whole month as a proration first.
    expect(anchorDayFor(5, at("2026-10-05T18:00:00Z"))).toBeNull();
  });

  it("decides 'today' in UTC, the calendar Stripe anchors in", () => {
    // 11pm on the 4th in Denver is already the 5th in UTC.
    expect(anchorDayFor(5, at("2026-10-05T05:00:00Z"))).toBeNull();
    expect(anchorDayFor(4, at("2026-10-05T05:00:00Z"))).toBe(4);
  });
});

describe("billingDayFromAnchor", () => {
  it("reads the day of month off the anchor", () => {
    expect(billingDayFromAnchor(seconds("2026-11-15T12:00:00Z"))).toBe(15);
  });

  it("keeps an anchor late in the month inside the 1–28 range", () => {
    expect(billingDayFromAnchor(seconds("2026-10-31T12:00:00Z"))).toBe(28);
  });
});

describe("shiftedAnchor", () => {
  const periodEnd = seconds("2026-11-05T15:30:00Z");

  it("moves the next payment to the chosen day after what they already paid for", () => {
    // Paid through 5 November; moving to the 15th makes the next payment
    // 15 November. The ten days between are not charged.
    expect(shiftedAnchor(15, periodEnd)).toBe(seconds("2026-11-15T15:30:00Z"));
  });

  it("rolls into the next month when the day has already passed", () => {
    // Paid through 5 November; the next 2nd after that is 2 December.
    expect(shiftedAnchor(2, periodEnd)).toBe(seconds("2026-12-02T15:30:00Z"));
  });

  it("does nothing when the day is already the renewal day", () => {
    expect(shiftedAnchor(5, periodEnd)).toBeNull();
  });

  it("never lands before the end of the period already paid for", () => {
    // Charging before then would bill days the client has already paid for.
    for (let day = 1; day <= 28; day += 1) {
      const next = shiftedAnchor(day, periodEnd);
      if (next !== null) expect(next).toBeGreaterThan(periodEnd);
    }
  });

  it("crosses a year end", () => {
    const december = seconds("2026-12-20T00:00:00Z");
    expect(shiftedAnchor(3, december)).toBe(seconds("2027-01-03T00:00:00Z"));
  });
});
