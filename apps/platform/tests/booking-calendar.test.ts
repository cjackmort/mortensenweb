import { describe, expect, it } from "vitest";
import { formatMonth, isMonth, monthBounds, monthWeeks, shiftMonth } from "@/lib/growth/booking-calendar";

/**
 * The month arithmetic behind the booking calendar. Calendar dates, never
 * instants: a grid built from `new Date()` in the server's timezone draws the
 * wrong first weekday for half the day somewhere.
 */

describe("the booking calendar's months", () => {
  it("accepts only a real year and month", () => {
    expect(isMonth("2026-11")).toBe(true);
    expect(isMonth("2026-13")).toBe(false);
    expect(isMonth("2026-1")).toBe(false);
    expect(isMonth("../2026-11")).toBe(false);
    expect(isMonth(undefined)).toBe(false);
  });

  it("steps across a year end both ways", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2027-01", -1)).toBe("2026-12");
  });

  it("knows each month's last day, leap years included", () => {
    expect(monthBounds("2026-11")).toEqual({ first: "2026-11-01", last: "2026-11-30" });
    expect(monthBounds("2028-02")).toEqual({ first: "2028-02-01", last: "2028-02-29" });
  });

  it("lays a month out in Sunday-first weeks with blanks around it", () => {
    // October 2026 starts on a Thursday and ends on a Saturday.
    const weeks = monthWeeks("2026-10");
    expect(weeks).toHaveLength(5);
    expect(weeks[0]).toEqual([null, null, null, null, "2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(weeks[4]).toEqual(["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31"]);
    // February 2026 starts on a Sunday and is exactly four weeks.
    expect(monthWeeks("2026-02")).toHaveLength(4);
  });

  it("names the month for the heading", () => {
    expect(formatMonth("2026-11")).toBe("November 2026");
  });
});
