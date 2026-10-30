import { describe, expect, it } from "vitest";
import {
  addDays,
  dateInZone,
  minuteOfDayInZone,
  weekdayOf,
  zonedTimeToInstant,
} from "@/lib/availability/time";
import {
  bookableWindow,
  findOpenSlot,
  normalizeRanges,
  openSlots,
  type SlotInput,
  type WeeklyHours,
} from "@/lib/availability/slots";

/**
 * The slot engine: weekly hours, minus days off, minus what is in the
 * client's Google Calendar, minus what is already booked, minus anything too
 * soon — in the business's own timezone.
 *
 * The failure that matters most is a quiet one: a slot offered at the wrong
 * instant. Off by an hour twice a year is a customer at a locked door, so
 * every DST edge in America/Denver has a test, with the expected instants
 * written out in UTC rather than computed by the code under test.
 */

const DENVER = "America/Denver";
const h = (hours: number, minutes = 0) => hours * 60 + minutes;
const range = (start: number, end: number) => ({ start, end });

const CLOSED: WeeklyHours = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };

function weekdays(...ranges: Array<{ start: number; end: number }>): WeeklyHours {
  return { ...CLOSED, 1: ranges, 2: ranges, 3: ranges, 4: ranges, 5: ranges };
}

function input(overrides: Partial<SlotInput>): SlotInput {
  return {
    timeZone: DENVER,
    slotMinutes: 60,
    bufferMinutes: 0,
    minNoticeMinutes: 0,
    horizonDays: 30,
    weekly: weekdays(range(h(9), h(12))),
    overrides: [],
    busy: [],
    booked: [],
    // Sunday 2026-10-18, 8 AM in Denver.
    now: new Date("2026-10-18T14:00:00.000Z"),
    ...overrides,
  };
}

const startsOn = (slots: ReturnType<typeof openSlots>, date: string) =>
  slots.filter((s) => s.date === date).map((s) => s.start.toISOString());

describe("wall-clock time in a timezone", () => {
  it("places 9 AM in Denver at 16:00 UTC in winter and 15:00 UTC in summer", () => {
    expect(zonedTimeToInstant("2026-01-15", h(9), DENVER).toISOString()).toBe("2026-01-15T16:00:00.000Z");
    expect(zonedTimeToInstant("2026-07-15", h(9), DENVER).toISOString()).toBe("2026-07-15T15:00:00.000Z");
  });

  it("moves a time that does not exist (the spring-forward gap) forward by the gap", () => {
    // 2026-03-08: 2:00 AM MST jumps to 3:00 AM MDT. 2:30 never happens.
    expect(zonedTimeToInstant("2026-03-08", h(2, 30), DENVER).toISOString()).toBe("2026-03-08T09:30:00.000Z");
    expect(minuteOfDayInZone(new Date("2026-03-08T09:30:00.000Z"), DENVER)).toBe(h(3, 30));
  });

  it("takes the first of a time that happens twice (the fall-back hour)", () => {
    // 2026-11-01: 1:30 AM happens in MDT (07:30Z) and again in MST (08:30Z).
    expect(zonedTimeToInstant("2026-11-01", h(1, 30), DENVER).toISOString()).toBe("2026-11-01T07:30:00.000Z");
  });

  it("treats minute 1440 as the next midnight", () => {
    expect(zonedTimeToInstant("2026-10-20", 1440, DENVER).toISOString()).toBe("2026-10-21T06:00:00.000Z");
  });

  it("reads the calendar date where the business is, not in UTC", () => {
    // 11:30 PM on the 29th in Denver is already the 30th in UTC.
    expect(dateInZone(new Date("2026-10-30T05:30:00.000Z"), DENVER)).toBe("2026-10-29");
    expect(dateInZone(new Date("2026-10-30T06:30:00.000Z"), DENVER)).toBe("2026-10-30");
  });

  it("does date arithmetic on calendar days", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(weekdayOf("2026-10-18")).toBe(0);
    expect(weekdayOf("2026-10-19")).toBe(1);
  });
});

describe("ranges", () => {
  it("sorts, merges overlapping and touching ranges, and drops nonsense", () => {
    expect(
      normalizeRanges([range(h(13), h(17)), range(h(9), h(12)), range(h(11), h(14)), range(h(18), h(18)), range(-5, 30)]),
    ).toEqual([range(h(9), h(17))]);
    expect(normalizeRanges([range(h(9), h(12)), range(h(12), h(13))])).toEqual([range(h(9), h(13))]);
  });
});

describe("open slots", () => {
  it("offers each whole slot inside the weekly hours, in the business's time", () => {
    const slots = openSlots(input({}));
    expect(startsOn(slots, "2026-10-19")).toEqual([
      "2026-10-19T15:00:00.000Z",
      "2026-10-19T16:00:00.000Z",
      "2026-10-19T17:00:00.000Z",
    ]);
    // Weekends are closed.
    expect(startsOn(slots, "2026-10-24")).toEqual([]);
    expect(slots[0]!.end.toISOString()).toBe("2026-10-19T16:00:00.000Z");
  });

  it("never offers a slot that runs past the end of the hours", () => {
    const slots = openSlots(input({ slotMinutes: 30, weekly: weekdays(range(h(9), h(10, 45))) }));
    expect(startsOn(slots, "2026-10-19").map((s) => minuteOfDayInZone(new Date(s), DENVER))).toEqual([
      h(9),
      h(9, 30),
      h(10),
    ]);
  });

  it("keeps a lunch break between two ranges on the same day", () => {
    const slots = openSlots(input({ weekly: weekdays(range(h(9), h(12)), range(h(13), h(15))) }));
    expect(startsOn(slots, "2026-10-19").map((s) => minuteOfDayInZone(new Date(s), DENVER))).toEqual([
      h(9),
      h(10),
      h(11),
      h(13),
      h(14),
    ]);
  });

  it("runs to midnight when the hours end at 24:00", () => {
    const slots = openSlots(input({ weekly: { ...CLOSED, 2: [range(h(22), 1440)] } }));
    expect(startsOn(slots, "2026-10-20")).toEqual(["2026-10-21T04:00:00.000Z", "2026-10-21T05:00:00.000Z"]);
  });
});

describe("daylight saving time", () => {
  const nineToFive = weekdays(range(h(9), h(17)));

  it("keeps 9 AM at 9 AM across the autumn change (MDT → MST, 2026-11-01)", () => {
    const slots = openSlots(input({ weekly: nineToFive, now: new Date("2026-10-29T12:00:00.000Z") }));
    // Friday before: 9 AM MDT is 15:00Z.
    expect(startsOn(slots, "2026-10-30")[0]).toBe("2026-10-30T15:00:00.000Z");
    // Monday after: 9 AM MST is 16:00Z.
    expect(startsOn(slots, "2026-11-02")[0]).toBe("2026-11-02T16:00:00.000Z");
    expect(startsOn(slots, "2026-11-02").at(-1)).toBe("2026-11-02T23:00:00.000Z");
    // Eight hourly slots either side: the day did not gain or lose one.
    expect(startsOn(slots, "2026-10-30")).toHaveLength(8);
    expect(startsOn(slots, "2026-11-02")).toHaveLength(8);
  });

  it("keeps 9 AM at 9 AM across the spring change (MST → MDT, 2026-03-08)", () => {
    const slots = openSlots(input({ weekly: nineToFive, now: new Date("2026-03-05T12:00:00.000Z") }));
    expect(startsOn(slots, "2026-03-06")[0]).toBe("2026-03-06T16:00:00.000Z");
    expect(startsOn(slots, "2026-03-09")[0]).toBe("2026-03-09T15:00:00.000Z");
    expect(startsOn(slots, "2026-03-06")).toHaveLength(8);
    expect(startsOn(slots, "2026-03-09")).toHaveLength(8);
  });

  it("counts real time on the night the clocks change", () => {
    const overnight = { ...CLOSED, 0: [range(0, h(4))] };
    // 2026-11-01: midnight to 4 AM is five real hours.
    const autumn = openSlots(input({ weekly: overnight, now: new Date("2026-10-31T12:00:00.000Z") }));
    expect(startsOn(autumn, "2026-11-01")).toEqual([
      "2026-11-01T06:00:00.000Z",
      "2026-11-01T07:00:00.000Z",
      "2026-11-01T08:00:00.000Z",
      "2026-11-01T09:00:00.000Z",
      "2026-11-01T10:00:00.000Z",
    ]);
    // 2026-03-08: midnight to 4 AM is three.
    const spring = openSlots(input({ weekly: overnight, now: new Date("2026-03-07T12:00:00.000Z") }));
    expect(startsOn(spring, "2026-03-08")).toEqual([
      "2026-03-08T07:00:00.000Z",
      "2026-03-08T08:00:00.000Z",
      "2026-03-08T09:00:00.000Z",
    ]);
  });

  it("follows the business's own zone's change date, not Denver's", () => {
    // London leaves BST on 2026-10-25; Denver is still on MDT that week.
    const slots = openSlots(
      input({ timeZone: "Europe/London", weekly: nineToFive, now: new Date("2026-10-21T06:00:00.000Z") }),
    );
    expect(startsOn(slots, "2026-10-23")[0]).toBe("2026-10-23T08:00:00.000Z");
    expect(startsOn(slots, "2026-10-26")[0]).toBe("2026-10-26T09:00:00.000Z");
  });
});

describe("days off and custom hours", () => {
  it("closes a date that is marked closed", () => {
    const slots = openSlots(input({ overrides: [{ date: "2026-10-20", ranges: [] }] }));
    expect(startsOn(slots, "2026-10-20")).toEqual([]);
    expect(startsOn(slots, "2026-10-21")).toHaveLength(3);
  });

  it("uses a date's own hours in place of the weekday's", () => {
    const slots = openSlots(input({ overrides: [{ date: "2026-10-20", ranges: [range(h(14), h(16))] }] }));
    expect(startsOn(slots, "2026-10-20")).toEqual(["2026-10-20T20:00:00.000Z", "2026-10-20T21:00:00.000Z"]);
  });

  it("can open a day that is normally closed", () => {
    const slots = openSlots(input({ overrides: [{ date: "2026-10-24", ranges: [range(h(10), h(11))] }] }));
    expect(startsOn(slots, "2026-10-24")).toEqual(["2026-10-24T16:00:00.000Z"]);
  });
});

describe("busy times and bookings", () => {
  const monday = (time: string) => new Date(`2026-10-19T${time}:00.000-06:00`);

  it("drops every slot a Google Calendar event overlaps, even partly", () => {
    const slots = openSlots(
      input({ slotMinutes: 30, busy: [{ start: monday("10:15"), end: monday("10:45") }] }),
    );
    const mins = startsOn(slots, "2026-10-19").map((s) => minuteOfDayInZone(new Date(s), DENVER));
    expect(mins).not.toContain(h(10));
    expect(mins).not.toContain(h(10, 30));
    expect(mins).toContain(h(9, 30));
    expect(mins).toContain(h(11));
  });

  it("lets a slot start the moment an event ends when there is no buffer", () => {
    const slots = openSlots(input({ busy: [{ start: monday("09:00"), end: monday("10:00") }] }));
    expect(startsOn(slots, "2026-10-19").map((s) => minuteOfDayInZone(new Date(s), DENVER))).toEqual([h(10), h(11)]);
  });

  it("keeps the buffer clear on both sides of an event", () => {
    const slots = openSlots(
      input({ slotMinutes: 30, bufferMinutes: 15, busy: [{ start: monday("10:00"), end: monday("10:30") }] }),
    );
    const mins = startsOn(slots, "2026-10-19").map((s) => minuteOfDayInZone(new Date(s), DENVER));
    // 9:30–10:00 ends inside the buffer before; 10:30 starts inside the one after.
    expect(mins).toEqual([h(9), h(11), h(11, 30)]);
  });

  it("treats an existing booking like a busy time", () => {
    const slots = openSlots(input({ booked: [{ start: monday("10:00"), end: monday("11:00") }] }));
    expect(startsOn(slots, "2026-10-19").map((s) => minuteOfDayInZone(new Date(s), DENVER))).toEqual([h(9), h(11)]);
  });
});

describe("notice and how far ahead", () => {
  it("offers nothing sooner than the minimum notice", () => {
    // Monday 8:30 AM in Denver, an hour's notice: 9 AM is too soon, 10 AM is not.
    const slots = openSlots(input({ minNoticeMinutes: 60, now: new Date("2026-10-19T14:30:00.000Z") }));
    expect(startsOn(slots, "2026-10-19").map((s) => minuteOfDayInZone(new Date(s), DENVER))).toEqual([h(10), h(11)]);
  });

  it("never offers a slot that has already started", () => {
    const slots = openSlots(input({ now: new Date("2026-10-19T15:30:00.000Z") }));
    expect(startsOn(slots, "2026-10-19").map((s) => minuteOfDayInZone(new Date(s), DENVER))).toEqual([h(10), h(11)]);
  });

  it("stops at the horizon, counted in the business's days", () => {
    const rules = input({ horizonDays: 7 });
    expect(bookableWindow(rules, rules.now)).toEqual({ first: "2026-10-18", last: "2026-10-24" });
    const everyDay = range(h(9), h(10));
    const slots = openSlots(
      input({ horizonDays: 7, weekly: { 0: [everyDay], 1: [everyDay], 2: [everyDay], 3: [everyDay], 4: [everyDay], 5: [everyDay], 6: [everyDay] } }),
    );
    expect(startsOn(slots, "2026-10-24")).toHaveLength(1);
    expect(startsOn(slots, "2026-10-25")).toEqual([]);
  });

  it("clips a requested window to today and the horizon", () => {
    const slots = openSlots(input({ from: "2026-10-01", to: "2026-10-20" }));
    expect([...new Set(slots.map((s) => s.date))]).toEqual(["2026-10-19", "2026-10-20"]);
  });
});

describe("checking one requested start", () => {
  it("finds a start the website offered", () => {
    const found = findOpenSlot(input({}), new Date("2026-10-19T16:00:00.000Z"));
    expect(found?.end.toISOString()).toBe("2026-10-19T17:00:00.000Z");
  });

  it("refuses a start off the grid, on a closed day, or already taken", () => {
    expect(findOpenSlot(input({}), new Date("2026-10-19T16:10:00.000Z"))).toBeNull();
    expect(findOpenSlot(input({}), new Date("2026-10-24T16:00:00.000Z"))).toBeNull();
    const taken = input({
      booked: [{ start: new Date("2026-10-19T16:00:00.000Z"), end: new Date("2026-10-19T17:00:00.000Z") }],
    });
    expect(findOpenSlot(taken, new Date("2026-10-19T16:00:00.000Z"))).toBeNull();
  });
});
