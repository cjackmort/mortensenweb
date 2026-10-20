import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { includesMonthlyReport } from "@/lib/reports/eligibility";
import {
  businessDayOfMonth,
  isCompletedPeriod,
  isPeriod,
  lastCompletedPeriod,
  nextPeriod,
  previousPeriod,
  reportWindow,
} from "@/lib/reports/period";
import { parseReportData, type MonthlyReportData } from "@/lib/reports/types";
import { glance, headline, trend } from "@/lib/reports/wording";

/**
 * The monthly report's arithmetic and wording.
 *
 * What would go wrong silently: a month boundary taken in UTC (a lead on the
 * evening of the 31st lands in the wrong report), and a missing figure worded
 * as a zero (a client reads "0 visitors" when analytics was never connected).
 */

beforeEach(() => {
  vi.stubEnv("BUSINESS_TIMEZONE", "America/Denver");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function report(overrides: Partial<MonthlyReportData> = {}): MonthlyReportData {
  return {
    version: 1,
    period: "2026-09",
    label: "September 2026",
    previousMonthName: "August",
    startAt: "2026-09-01T06:00:00.000Z",
    endAt: "2026-10-01T06:00:00.000Z",
    businessName: "Acme Plumbing",
    site: { name: "Acme", domain: "acme.example" },
    planName: "Care",
    visitors: {
      state: "ok",
      visitors: 312,
      pageviews: 801,
      previousVisitors: 264,
      change: (312 - 264) / 264,
      topPages: [],
      sources: [],
    },
    contact: { state: "ok", rows: [{ id: "phone_tapped", count: 23 }] },
    enquiries: { state: "ok", received: 7, previous: 4, won: 2, awaitingReply: 1 },
    changes: { items: [] },
    health: { state: "ok", live: true, lastConfirmedAt: "2026-10-01T08:00:00.000Z", stale: false },
    extras: [],
    builtAt: "2026-10-01T09:00:00.000Z",
    ...overrides,
  };
}

describe("report periods", () => {
  it("accepts only YYYY-MM", () => {
    expect(isPeriod("2026-09")).toBe(true);
    for (const bad of ["2026-13", "2026-9", "2026-09-01", "../2026-09", "", null, 202609]) {
      expect(isPeriod(bad)).toBe(false);
    }
  });

  it("steps across a year boundary", () => {
    expect(previousPeriod("2026-01")).toBe("2025-12");
    expect(nextPeriod("2026-12")).toBe("2027-01");
  });

  it("starts and ends the month at local midnight, not UTC", () => {
    const window = reportWindow("2026-09");
    // MDT is UTC-6.
    expect(window.startAt.toISOString()).toBe("2026-09-01T06:00:00.000Z");
    expect(window.endAt.toISOString()).toBe("2026-10-01T06:00:00.000Z");
    expect(window.label).toBe("September 2026");
    expect(window.lastDay).toBe("2026-09-30");
  });

  it("ends a month on the right hour when daylight saving changes inside it", () => {
    // DST ends on 1 November 2026; October's window ends at midnight MDT on
    // the 1st, and November's at midnight MST on 1 December.
    expect(reportWindow("2026-10").endAt.toISOString()).toBe("2026-11-01T06:00:00.000Z");
    expect(reportWindow("2026-11").endAt.toISOString()).toBe("2026-12-01T07:00:00.000Z");
  });

  it("treats the evening of the 31st as the old month in the business timezone", () => {
    // 11pm on 31 October in Denver is 1 November in UTC.
    const lateOnThe31st = new Date("2026-11-01T05:00:00.000Z");
    expect(lastCompletedPeriod(lateOnThe31st)).toBe("2026-09");
    expect(businessDayOfMonth(lateOnThe31st)).toBe(31);

    const earlyOnThe1st = new Date("2026-11-01T07:00:00.000Z");
    expect(lastCompletedPeriod(earlyOnThe1st)).toBe("2026-10");
    expect(businessDayOfMonth(earlyOnThe1st)).toBe(1);
  });

  it("knows a month in progress is not finished", () => {
    const now = new Date("2026-10-14T18:00:00.000Z");
    expect(isCompletedPeriod("2026-09", now)).toBe(true);
    expect(isCompletedPeriod("2026-10", now)).toBe(false);
  });
});

describe("who gets a report", () => {
  it("includes Care and every plan above it", () => {
    for (const planKey of ["care", "growth", "pro"]) {
      expect(includesMonthlyReport({ planKey, comped: false })).toBe(true);
    }
  });

  it("leaves out Lite, no plan, and keys the plans package does not know", () => {
    for (const planKey of ["lite", null, "test-dollar", "care-unlimited"]) {
      expect(includesMonthlyReport({ planKey, comped: false })).toBe(false);
    }
  });

  it("gives a comped client everything, like Growth access does", () => {
    expect(includesMonthlyReport({ planKey: null, comped: true })).toBe(true);
  });
});

describe("the headline", () => {
  it("reads like the brief: visitors and trend, then enquiries", () => {
    expect(headline(report())).toBe("312 visitors, up 18%; 7 enquiries; 23 taps to call");
  });

  it("says a missing analytics figure is missing, never zero", () => {
    const text = headline(report({ visitors: { state: "missing", reason: "analytics_not_connected" } }));
    expect(text).toBe("Visitors: analytics not connected yet; 7 enquiries; 23 taps to call");
    expect(text).not.toMatch(/\b0 visitors/);
  });

  it("drops the trend when there is nothing to compare against", () => {
    const data = report();
    if (data.visitors.state !== "ok") throw new Error("fixture");
    const text = headline({ ...data, visitors: { ...data.visitors, previousVisitors: null, change: null } });
    expect(text.startsWith("312 visitors; ")).toBe(true);
  });

  it("leaves out enquiries when the plan has no leads inbox", () => {
    expect(headline(report({ enquiries: null }))).toBe("312 visitors, up 18%; 23 taps to call");
  });

  it("uses singular nouns for one", () => {
    const data = report({
      enquiries: { state: "ok", received: 1, previous: null, won: 0, awaitingReply: 1 },
      contact: { state: "ok", rows: [{ id: "phone_tapped", count: 1 }] },
    });
    expect(headline(data)).toContain("1 enquiry; 1 tap to call");
  });

  it("does not shout about zero taps when the site tracks them", () => {
    const data = report({ contact: { state: "ok", rows: [{ id: "phone_tapped", count: 0 }] } });
    expect(headline(data)).not.toContain("tap");
  });

  it("takes a Growth section's own headline phrase", () => {
    const data = report({
      enquiries: null,
      contact: { state: "missing", reason: "not_tracked" },
      extras: [{ key: "reviews", title: "Google reviews", state: "ok", headline: "4 new reviews", rows: [], note: null }],
    });
    expect(headline(data)).toBe("312 visitors, up 18%; 4 new reviews");
  });
});

describe("trend", () => {
  it("rounds, and calls a sub-percent move the same", () => {
    expect(trend(0.184)).toBe("up 18%");
    expect(trend(-0.05)).toBe("down 5%");
    expect(trend(0.004)).toBe("about the same");
    expect(trend(null)).toBeNull();
  });
});

describe("the summary lines", () => {
  it("states every missing figure as missing", () => {
    const lines = glance(
      report({
        visitors: { state: "missing", reason: "analytics_not_configured" },
        contact: { state: "missing", reason: "analytics_not_configured" },
        enquiries: { state: "missing", reason: "forms_not_connected" },
      }),
    );
    const byKey = Object.fromEntries(lines.map((line) => [line.key, line]));
    expect(byKey.visitors).toMatchObject({ missing: true, text: "Analytics not connected yet" });
    expect(byKey.contact).toMatchObject({ missing: true });
    expect(byKey.enquiries).toMatchObject({ missing: true, text: "Contact form not connected yet" });
    for (const line of lines.filter((l) => l.missing)) expect(line.text).not.toMatch(/^0\b/);
  });

  it("compares with the previous month by name", () => {
    const byKey = Object.fromEntries(glance(report()).map((line) => [line.key, line.text]));
    expect(byKey.visitors).toBe("312, up 18% on August");
    expect(byKey.enquiries).toBe("7 (4 in August)");
    expect(byKey.changes).toBe("None this month");
  });
});

describe("reading a stored report", () => {
  it("round-trips a report it wrote", () => {
    const data = report();
    expect(parseReportData(JSON.parse(JSON.stringify(data)))).toEqual(data);
  });

  it("refuses a report it cannot read rather than guessing", () => {
    expect(parseReportData({ version: 2 })).toBeNull();
    expect(parseReportData({ ...report(), visitors: { state: "ok", visitors: "312" } })).toBeNull();
  });
});
