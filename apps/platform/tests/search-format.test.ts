import { describe, expect, it } from "vitest";
import {
  averagePosition,
  dailySeries,
  formatCount,
  formatPosition,
  formatRate,
  formatWindow,
  rankQueries,
  searchHeadline,
} from "@/lib/search/format";

/**
 * The Search card's words and numbers.
 *
 * What would go wrong quietly: a headline that says "0 times, average
 * position 0.0" for a site Google never showed; a position reported to five
 * decimals; a sparkline that skips the quiet days and so looks busier than
 * the month was; and a table that lists a rarely shown search above a busy one.
 */

describe("formatting", () => {
  it("rounds counts with thousands separators", () => {
    expect(formatCount(1240)).toBe("1,240");
    expect(formatCount(1239.6)).toBe("1,240");
    expect(formatCount(0)).toBe("0");
  });

  it("shows position to one decimal, and a dash when there is no rank", () => {
    expect(formatPosition(4.23517)).toBe("4.2");
    expect(formatPosition(0)).toBe("–");
    expect(formatPosition(Number.NaN)).toBe("–");
  });

  it("shows click rate as a percentage of one decimal", () => {
    expect(formatRate(0.03)).toBe("3.0%");
    expect(formatRate(0.0051)).toBe("0.5%");
    expect(formatRate(0)).toBe("0.0%");
  });

  it("names the window by its first and last day", () => {
    expect(formatWindow("2026-09-28", "2026-10-25")).toBe("Sep 28 – Oct 25");
  });
});

describe("the headline", () => {
  it("says how often the site was shown and where it ranked", () => {
    expect(searchHeadline({ clicks: 50, impressions: 1240, ctr: 0.04, position: 4.2 })).toBe(
      "You showed up 1,240 times, average position 4.2",
    );
  });

  it("never reads as a row of zeros when Google showed the site to nobody", () => {
    expect(searchHeadline({ clicks: 0, impressions: 0, ctr: 0, position: 0 })).toBe(
      "Google did not show your site in the last 28 days",
    );
  });

  it("handles one impression and a missing position", () => {
    expect(searchHeadline({ clicks: 0, impressions: 1, ctr: 0, position: 0 })).toBe("You showed up once");
  });
});

describe("the daily series", () => {
  const daily = [
    { date: "2026-10-01", clicks: 2, impressions: 40, position: 5 },
    { date: "2026-10-03", clicks: 1, impressions: 10, position: 9 },
  ];

  it("fills the days Google left out with zero, so the trend keeps its shape", () => {
    expect(dailySeries(daily, { startDate: "2026-10-01", endDate: "2026-10-04" }, (d) => d.impressions)).toEqual([
      40, 0, 10, 0,
    ]);
  });

  it("is empty for a snapshot stored before the series existed", () => {
    expect(dailySeries(undefined, { startDate: "2026-10-01", endDate: "2026-10-02" }, (d) => d.clicks)).toEqual([0, 0]);
  });

  it("averages position over the days the site was shown, weighted by how often", () => {
    expect(averagePosition(daily)).toBeCloseTo((5 * 40 + 9 * 10) / 50);
    expect(averagePosition([])).toBe(0);
    expect(averagePosition([{ date: "2026-10-01", clicks: 0, impressions: 0, position: 0 }])).toBe(0);
  });
});

describe("the query table", () => {
  it("lists the most shown first, breaking ties by clicks", () => {
    const ranked = rankQueries([
      { key: "b", clicks: 1, impressions: 10, ctr: 0.1, position: 3 },
      { key: "a", clicks: 5, impressions: 10, ctr: 0.5, position: 2 },
      { key: "c", clicks: 0, impressions: 90, ctr: 0, position: 12 },
    ]);
    expect(ranked.map((q) => q.key)).toEqual(["c", "a", "b"]);
  });
});
