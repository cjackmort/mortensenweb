import { describe, expect, it } from "vitest";
import {
  DEFAULT_DUNNING_CONFIG,
  daysOverdue,
  decideDunningAction,
  paymentStanding,
  reminderDedupeKey,
  stageForDaysOverdue,
  validateDunningConfig,
  type DunningInput,
} from "@/lib/billing/dunning";

const due = new Date("2026-08-01T00:00:00Z");
const open = (overrides: Partial<DunningInput> = {}): DunningInput => ({
  status: "open",
  dueOn: due,
  dunningStage: "none",
  ...overrides,
});

function dayAfterDue(days: number): Date {
  return new Date(due.getTime() + days * 24 * 60 * 60 * 1000);
}

describe("daysOverdue", () => {
  it("is zero on the due date and negative before it", () => {
    expect(daysOverdue(due, due)).toBe(0);
    expect(daysOverdue(due, dayAfterDue(-5))).toBe(-5);
    expect(daysOverdue(due, dayAfterDue(7))).toBe(7);
  });

  it("ignores time of day, so a job running at 23:59 matches one at 00:01", () => {
    const lateInDay = new Date("2026-08-04T23:59:00Z");
    const earlyInDay = new Date("2026-08-04T00:01:00Z");
    expect(daysOverdue(due, lateInDay)).toBe(daysOverdue(due, earlyInDay));
  });
});

describe("the ladder", () => {
  it("climbs at the configured thresholds", () => {
    expect(stageForDaysOverdue(0)).toBe("none");
    expect(stageForDaysOverdue(2)).toBe("none");
    expect(stageForDaysOverdue(3)).toBe("first_reminder");
    expect(stageForDaysOverdue(9)).toBe("first_reminder");
    expect(stageForDaysOverdue(10)).toBe("second_reminder");
    expect(stageForDaysOverdue(21)).toBe("final_notice");
    expect(stageForDaysOverdue(30)).toBe("management_paused");
    expect(stageForDaysOverdue(400)).toBe("management_paused");
  });

  it("sends nothing before the first threshold", () => {
    expect(decideDunningAction(open(), dayAfterDue(2))).toEqual({
      kind: "none",
      reason: "not_yet_due",
    });
  });

  it("sends the first reminder on day three", () => {
    expect(decideDunningAction(open(), dayAfterDue(3))).toEqual({
      kind: "send_reminder",
      stage: "first_reminder",
    });
  });

  it("pauses management at thirty days", () => {
    expect(
      decideDunningAction(open({ dunningStage: "final_notice" }), dayAfterDue(30)),
    ).toEqual({ kind: "pause_management" });
  });
});

describe("a client who says they have paid is never chased", () => {
  // The most important test in this file. Venmo gives no callback, so there is
  // always a window between the client paying and the operator confirming.
  it("suppresses reminders while awaiting confirmation, however overdue", () => {
    for (const day of [3, 10, 21, 30, 90]) {
      expect(
        decideDunningAction(
          open({ status: "awaiting_confirmation" }),
          dayAfterDue(day),
        ),
      ).toEqual({ kind: "none", reason: "awaiting_confirmation" });
    }
  });

  it("does not pause management while awaiting confirmation", () => {
    const action = decideDunningAction(
      open({ status: "awaiting_confirmation", dunningStage: "final_notice" }),
      dayAfterDue(60),
    );
    expect(action.kind).toBe("none");
  });
});

describe("idempotency", () => {
  it("does not resend a rung already recorded", () => {
    expect(
      decideDunningAction(open({ dunningStage: "first_reminder" }), dayAfterDue(5)),
    ).toEqual({ kind: "none", reason: "stage_already_sent" });
  });

  it("is a no-op when run repeatedly on the same day", () => {
    const at = dayAfterDue(10);
    const first = decideDunningAction(open(), at);
    expect(first).toEqual({ kind: "send_reminder", stage: "second_reminder" });

    // Simulate the job having recorded that rung, then running again.
    const second = decideDunningAction(
      open({ dunningStage: "second_reminder" }),
      at,
    );
    expect(second.kind).toBe("none");
  });

  it("skips intermediate rungs after an outage rather than sending a burst", () => {
    // The job has not run for a month. The client should receive the rung the
    // calendar justifies, not four emails in one minute.
    const action = decideDunningAction(open(), dayAfterDue(25));
    expect(action).toEqual({ kind: "send_reminder", stage: "final_notice" });
  });

  it("never moves backwards", () => {
    expect(
      decideDunningAction(open({ dunningStage: "final_notice" }), dayAfterDue(4)),
    ).toEqual({ kind: "none", reason: "stage_already_sent" });
  });

  it("stops entirely once management is paused", () => {
    expect(
      decideDunningAction(
        open({ dunningStage: "management_paused" }),
        dayAfterDue(120),
      ),
    ).toEqual({ kind: "none", reason: "already_paused" });
  });

  it("produces a stable dedupe key per request and rung", () => {
    expect(reminderDedupeKey("abc", "first_reminder")).toBe(
      "payment_reminder:abc:first_reminder",
    );
    expect(reminderDedupeKey("abc", "first_reminder")).not.toBe(
      reminderDedupeKey("abc", "second_reminder"),
    );
  });
});

describe("statuses that must never be chased", () => {
  it.each(["paid", "cancelled", "written_off", "draft"] as const)(
    "ignores %s requests",
    (status) => {
      expect(decideDunningAction(open({ status }), dayAfterDue(90))).toEqual({
        kind: "none",
        reason: "not_chaseable",
      });
    },
  );

  it("ignores a request with no due date rather than guessing one", () => {
    expect(decideDunningAction(open({ dueOn: null }), dayAfterDue(90))).toEqual({
      kind: "none",
      reason: "no_due_date",
    });
  });

  it("honours an operator exemption, e.g. an agreed payment plan", () => {
    const action = decideDunningAction(
      open({ exemptUntil: dayAfterDue(60) }),
      dayAfterDue(30),
    );
    expect(action).toEqual({ kind: "none", reason: "exempt" });
  });

  it("resumes once the exemption lapses", () => {
    const action = decideDunningAction(
      open({ exemptUntil: dayAfterDue(10) }),
      dayAfterDue(30),
    );
    expect(action).toEqual({ kind: "pause_management" });
  });
});

describe("what the client is shown", () => {
  it("counts down before the due date", () => {
    expect(paymentStanding(open(), dayAfterDue(-5))).toEqual({
      state: "due",
      dueOn: due,
      daysUntilDue: 5,
    });
  });

  it("shows awaiting confirmation rather than overdue after they pay", () => {
    expect(
      paymentStanding(open({ status: "awaiting_confirmation" }), dayAfterDue(40)),
    ).toEqual({ state: "awaiting_confirmation" });
  });

  it("reports overdue with a day count", () => {
    expect(paymentStanding(open(), dayAfterDue(12))).toEqual({
      state: "overdue",
      dueOn: due,
      daysOverdue: 12,
    });
  });

  it("reports unmanaged past the pause threshold", () => {
    const standing = paymentStanding(open(), dayAfterDue(45));
    expect(standing.state).toBe("unmanaged");
  });

  it("shows paid up when nothing is outstanding", () => {
    expect(paymentStanding(open({ status: "paid" }), dayAfterDue(5))).toEqual({
      state: "paid_up",
    });
  });
});

describe("configuration", () => {
  const gentle = {
    firstReminderDays: 14,
    secondReminderDays: 30,
    finalNoticeDays: 45,
    pauseManagementDays: 90,
  };

  it("respects a custom ladder", () => {
    expect(decideDunningAction(open(), dayAfterDue(5), gentle)).toEqual({
      kind: "none",
      reason: "not_yet_due",
    });
    expect(decideDunningAction(open(), dayAfterDue(14), gentle)).toEqual({
      kind: "send_reminder",
      stage: "first_reminder",
    });
    expect(decideDunningAction(open(), dayAfterDue(60), gentle)).toEqual({
      kind: "send_reminder",
      stage: "final_notice",
    });
  });

  it("accepts the shipped default", () => {
    expect(() => validateDunningConfig(DEFAULT_DUNNING_CONFIG)).not.toThrow();
    expect(() => validateDunningConfig(gentle)).not.toThrow();
  });

  it("rejects a ladder whose rungs are out of order", () => {
    // This exact mistake silently skips the first rung: day 14 already
    // satisfies a second threshold of 10, so the client would receive the
    // second reminder first and never see the gentler one.
    expect(() =>
      validateDunningConfig({
        ...DEFAULT_DUNNING_CONFIG,
        firstReminderDays: 14,
      }),
    ).toThrow(/secondReminderDays/);
  });

  it("rejects equal thresholds, which make a rung unreachable", () => {
    expect(() =>
      validateDunningConfig({
        firstReminderDays: 3,
        secondReminderDays: 3,
        finalNoticeDays: 21,
        pauseManagementDays: 30,
      }),
    ).toThrow();
  });

  it("rejects negative or fractional days", () => {
    expect(() =>
      validateDunningConfig({ ...DEFAULT_DUNNING_CONFIG, firstReminderDays: -1 }),
    ).toThrow();
    expect(() =>
      validateDunningConfig({ ...DEFAULT_DUNNING_CONFIG, firstReminderDays: 1.5 }),
    ).toThrow();
  });
});
