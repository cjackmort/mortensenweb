/**
 * Non-payment handling.
 *
 * Two properties matter more than anything else here, and both are structural:
 *
 * 1. **A client who has said they paid is never chased.** Venmo sends no
 *    callback, so there is an unavoidable window between a client paying and
 *    the operator confirming it. Emailing "you are overdue" into that window is
 *    the single worst failure this feature can produce — it is wrong, it is
 *    about money, and it damages a relationship the agency depends on.
 *    `awaiting_confirmation` therefore suppresses the entire ladder.
 *
 * 2. **The ladder never runs backwards and never repeats a rung.** Reminder
 *    sending is driven by a scheduled job, and scheduled jobs get retried,
 *    fire twice, or catch up after an outage. Every decision here is derived
 *    from stored state rather than from "what time is it now", so running the
 *    job ten times in a row sends nothing extra.
 *
 * Losing service means losing *labour*, never hosting. See `managementState`.
 */

export type DunningStage =
  | "none"
  | "first_reminder"
  | "second_reminder"
  | "final_notice"
  | "management_paused";

/** Rung ordering. Used to guarantee the ladder is monotonic. */
const STAGE_ORDER: Record<DunningStage, number> = {
  none: 0,
  first_reminder: 1,
  second_reminder: 2,
  final_notice: 3,
  management_paused: 4,
};

export interface DunningConfig {
  /** Days after the due date before the first reminder. */
  firstReminderDays: number;
  secondReminderDays: number;
  finalNoticeDays: number;
  /** Days after which management pauses. The site stays up. */
  pauseManagementDays: number;
}

/**
 * Defaults chosen to be firm but not aggressive. A small contractor who is
 * three days late is usually busy, not refusing to pay; a month is a decision.
 */
export const DEFAULT_DUNNING_CONFIG: DunningConfig = {
  firstReminderDays: 3,
  secondReminderDays: 10,
  finalNoticeDays: 21,
  pauseManagementDays: 30,
};

/**
 * Reject a ladder whose rungs are not in ascending order.
 *
 * A config like `{ firstReminderDays: 14, secondReminderDays: 10 }` is not a
 * gentler ladder — it silently skips the first rung, because day 14 already
 * satisfies the second threshold. That is a confusing way to discover you have
 * been sending clients the wrong email, so it fails loudly at the boundary.
 */
export function validateDunningConfig(config: DunningConfig): void {
  const rungs: Array<[string, number]> = [
    ["firstReminderDays", config.firstReminderDays],
    ["secondReminderDays", config.secondReminderDays],
    ["finalNoticeDays", config.finalNoticeDays],
    ["pauseManagementDays", config.pauseManagementDays],
  ];

  for (const [name, value] of rungs) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Dunning config ${name} must be a non-negative integer.`);
    }
  }

  for (let i = 1; i < rungs.length; i += 1) {
    const [prevName, prevValue] = rungs[i - 1]!;
    const [name, value] = rungs[i]!;
    if (value <= prevValue) {
      throw new Error(
        `Dunning config ${name} (${value}) must be greater than ${prevName} (${prevValue}).`,
      );
    }
  }
}

export interface DunningInput {
  status:
    | "draft"
    | "open"
    | "awaiting_confirmation"
    | "paid"
    | "overdue"
    | "cancelled"
    | "written_off";
  dueOn: Date | null;
  dunningStage: DunningStage;
  /** Operator-set grace period, e.g. an agreed payment plan. */
  exemptUntil?: Date | null;
}

export type DunningAction =
  | { kind: "none"; reason: NoActionReason }
  | { kind: "send_reminder"; stage: Exclude<DunningStage, "none"> }
  | { kind: "pause_management" };

export type NoActionReason =
  | "not_chaseable"
  | "awaiting_confirmation"
  | "no_due_date"
  | "not_yet_due"
  | "exempt"
  | "stage_already_sent"
  | "already_paused";

/** Whole days elapsed since the due date. Negative before it falls due. */
export function daysOverdue(dueOn: Date, now: Date): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const due = Date.UTC(
    dueOn.getUTCFullYear(),
    dueOn.getUTCMonth(),
    dueOn.getUTCDate(),
  );
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return Math.floor((today - due) / MS_PER_DAY);
}

/** The rung the elapsed time alone would justify. */
export function stageForDaysOverdue(
  days: number,
  config: DunningConfig = DEFAULT_DUNNING_CONFIG,
): DunningStage {
  if (days >= config.pauseManagementDays) return "management_paused";
  if (days >= config.finalNoticeDays) return "final_notice";
  if (days >= config.secondReminderDays) return "second_reminder";
  if (days >= config.firstReminderDays) return "first_reminder";
  return "none";
}

/**
 * Decide what, if anything, should happen to one payment request right now.
 *
 * Pure: no clock, no database, no email. The caller supplies `now`, which makes
 * the whole ladder testable at any point on the timeline.
 */
export function decideDunningAction(
  input: DunningInput,
  now: Date,
  config: DunningConfig = DEFAULT_DUNNING_CONFIG,
): DunningAction {
  // The client has told us they paid. Do not chase them while we owe them a
  // confirmation. This is the guard that makes off-platform payment safe.
  if (input.status === "awaiting_confirmation") {
    return { kind: "none", reason: "awaiting_confirmation" };
  }

  if (input.status !== "open" && input.status !== "overdue") {
    return { kind: "none", reason: "not_chaseable" };
  }

  if (!input.dueOn) {
    return { kind: "none", reason: "no_due_date" };
  }

  if (input.exemptUntil && input.exemptUntil > now) {
    return { kind: "none", reason: "exempt" };
  }

  if (input.dunningStage === "management_paused") {
    return { kind: "none", reason: "already_paused" };
  }

  const days = daysOverdue(input.dueOn, now);
  if (days < config.firstReminderDays) {
    return { kind: "none", reason: "not_yet_due" };
  }

  const target = stageForDaysOverdue(days, config);

  // Unreachable given the threshold check above, but stated explicitly rather
  // than asserted away: it keeps the return type honest and would catch a
  // future config change that made the first rung reachable at zero days.
  if (target === "none") {
    return { kind: "none", reason: "not_yet_due" };
  }

  // Monotonic: only act when the elapsed time justifies a rung strictly higher
  // than the one already recorded. Re-running the job is therefore a no-op.
  if (STAGE_ORDER[target] <= STAGE_ORDER[input.dunningStage]) {
    return { kind: "none", reason: "stage_already_sent" };
  }

  if (target === "management_paused") {
    return { kind: "pause_management" };
  }

  return { kind: "send_reminder", stage: target };
}

/**
 * Idempotency key for the notification row.
 *
 * The unique index on `notifications.dedupe_key` is what actually prevents a
 * duplicate send; this function just has to be deterministic for a given
 * request and rung.
 */
export function reminderDedupeKey(
  paymentRequestId: string,
  stage: DunningStage,
): string {
  return `payment_reminder:${paymentRequestId}:${stage}`;
}

/** Client-facing state, derived rather than stored. */
export type PaymentStanding =
  | { state: "paid_up" }
  | { state: "due"; dueOn: Date; daysUntilDue: number }
  | { state: "awaiting_confirmation" }
  | { state: "overdue"; dueOn: Date; daysOverdue: number }
  | { state: "unmanaged"; dueOn: Date; daysOverdue: number };

export function paymentStanding(
  input: DunningInput,
  now: Date,
  config: DunningConfig = DEFAULT_DUNNING_CONFIG,
): PaymentStanding {
  if (input.status === "awaiting_confirmation") {
    return { state: "awaiting_confirmation" };
  }
  if (input.status !== "open" && input.status !== "overdue") {
    return { state: "paid_up" };
  }
  if (!input.dueOn) return { state: "paid_up" };

  const days = daysOverdue(input.dueOn, now);
  if (days < 0) {
    return { state: "due", dueOn: input.dueOn, daysUntilDue: -days };
  }
  if (days >= config.pauseManagementDays) {
    return { state: "unmanaged", dueOn: input.dueOn, daysOverdue: days };
  }
  if (days === 0) {
    return { state: "due", dueOn: input.dueOn, daysUntilDue: 0 };
  }
  return { state: "overdue", dueOn: input.dueOn, daysOverdue: days };
}
