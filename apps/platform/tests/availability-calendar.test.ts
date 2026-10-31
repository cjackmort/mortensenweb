import { describe, expect, it } from "vitest";
import { bookingsByDate, compactHours, dayHours, rangesToFields, weekdayName } from "@/lib/availability/calendar";
import { emptyWeek } from "@/lib/availability/slots";

/**
 * What the Availability calendar says about a day, worked out apart from the
 * screen. A wrong answer here is a client who sees a day as open when their
 * website offers nothing, so the rule is the slot engine's own: a date's own
 * hours win, else its weekday's.
 */

const week = () => ({
  ...emptyWeek(),
  1: [{ start: 540, end: 1020 }],
  2: [
    { start: 540, end: 720 },
    { start: 780, end: 1020 },
  ],
});

describe("a day's hours on the calendar", () => {
  it("follows the weekday when the date has nothing of its own", () => {
    // 2026-10-19 is a Monday.
    expect(dayHours("2026-10-19", week(), new Map())).toEqual({ ranges: [{ start: 540, end: 1020 }], own: false });
  });

  it("uses the date's own hours over its weekday's, and says they are its own", () => {
    const own = new Map([["2026-10-19", [{ start: 600, end: 660 }]]]);
    expect(dayHours("2026-10-19", week(), own)).toEqual({ ranges: [{ start: 600, end: 660 }], own: true });
  });

  it("reads a closed date as closed even though its weekday is open", () => {
    expect(dayHours("2026-10-19", week(), new Map([["2026-10-19", []]]))).toEqual({ ranges: [], own: true });
  });

  it("is closed on a weekday with no hours, and not 'own'", () => {
    // 2026-10-18 is a Sunday.
    expect(dayHours("2026-10-18", week(), new Map())).toEqual({ ranges: [], own: false });
  });

  it("merges overlapping blocks the way the website does", () => {
    const own = new Map([
      [
        "2026-10-19",
        [
          { start: 600, end: 720 },
          { start: 700, end: 800 },
        ],
      ],
    ]);
    expect(dayHours("2026-10-19", week(), own).ranges).toEqual([{ start: 600, end: 800 }]);
  });
});

describe("hours as they fit in a calendar cell", () => {
  it("writes a single block short, with am/pm only as a letter", () => {
    expect(compactHours([{ start: 540, end: 1020 }])).toBe("9a–5p");
    expect(compactHours([{ start: 570, end: 1020 }])).toBe("9:30a–5p");
    expect(compactHours([{ start: 540, end: 720 }])).toBe("9a–12p");
  });

  it("counts the blocks after the first", () => {
    expect(
      compactHours([
        { start: 540, end: 720 },
        { start: 780, end: 1020 },
      ]),
    ).toBe("9a–12p +1");
  });

  it("says closed for no blocks, and midnight for the end of the day", () => {
    expect(compactHours([])).toBe("Closed");
    expect(compactHours([{ start: 1020, end: 1440 }])).toBe("5p–12a");
  });
});

describe("hours as the editor's time fields hold them", () => {
  it("turns minutes into clock fields, with midnight at the day's end as 00:00", () => {
    expect(
      rangesToFields([
        { start: 540, end: 720 },
        { start: 780, end: 1440 },
      ]),
    ).toEqual([
      { start: "09:00", end: "12:00" },
      { start: "13:00", end: "00:00" },
    ]);
  });
});

describe("bookings grouped by the day they are on", () => {
  const at = (publicId: string, iso: string, status: "pending" | "confirmed", timeZone = "America/Denver") => ({
    publicId,
    customerName: `Customer ${publicId}`,
    startsAt: new Date(iso),
    timeZone,
    status,
  });

  it("groups each date's bookings soonest first, with the time in the business's zone", () => {
    const days = bookingsByDate([
      at("b", "2026-10-20T18:00:00Z", "confirmed"),
      at("a", "2026-10-20T16:00:00Z", "pending"),
      at("c", "2026-10-21T16:00:00Z", "confirmed"),
    ]);
    expect(days["2026-10-20"]).toEqual([
      { publicId: "a", time: "10:00 AM", name: "Customer a", status: "pending" },
      { publicId: "b", time: "12:00 PM", name: "Customer b", status: "confirmed" },
    ]);
    expect(days["2026-10-21"]).toHaveLength(1);
    expect(days["2026-10-22"]).toBeUndefined();
  });

  it("puts a booking on the business's date, not UTC's", () => {
    // 9 PM in Denver on the 20th is already the 21st in UTC.
    const days = bookingsByDate([at("a", "2026-10-21T03:00:00Z", "confirmed")]);
    expect(days["2026-10-20"]).toHaveLength(1);
    expect(days["2026-10-21"]).toBeUndefined();
  });
});

describe("a date's weekday", () => {
  it("names the weekday of the calendar date, wherever the server's clock is", () => {
    expect(weekdayName("2026-10-20")).toBe("Tuesday");
    expect(weekdayName("2026-11-01")).toBe("Sunday");
  });
});
