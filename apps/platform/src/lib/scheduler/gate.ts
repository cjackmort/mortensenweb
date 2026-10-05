import { isProductionContext, onNetlify } from "@/lib/storage/driver";

/**
 * Whether a scheduled tick is worth waking the database for.
 *
 * ## Why this exists
 *
 * Neon suspends a compute after five minutes without a query, and on the Free
 * plan that timeout cannot be changed. The scheduler ticks every five minutes
 * and every tick queried, so the idle timer never ran out: the database stayed
 * awake around the clock whether or not anyone was using the portal. That is
 * ~180 CU-hours a month against a 100 CU-hour allowance, so it ran out
 * mid-month — and Neon then suspends the compute until the period resets,
 * which 500s every page that reads data.
 *
 * Compute is billed by the hours the database is awake, not by the number of
 * queries. So the fix is not making the jobs cheaper; it is not waking the
 * database on a tick that has nothing to do.
 *
 * ## How
 *
 * Two timestamps, kept in Netlify Blobs because reading them must not touch
 * Neon:
 *
 *  - **awake-until.** Pushed forward by the things that create work a client
 *    is waiting on: a submit or an approval (the nudge), a GitHub delivery that
 *    moved an agent job, an agent run starting (held until its watchdog can
 *    fire). While it is in the future every tick runs, exactly as before.
 *  - **last-run.** When the jobs last ran. Once it is `SWEEP_INTERVAL_MS` old
 *    the tick runs anyway, so the housekeeping jobs — live-site checks, share
 *    expiry, upload sweeps, Stripe reconciliation — still run, just less often,
 *    and so does anything a wake site missed.
 *
 * Deliberately a window opened by events, not a query for outstanding work.
 * Outstanding work can be stuck — a request refused for having no repository
 * stays `submitted` indefinitely — and a gate that held the loop awake while
 * anything was outstanding would hold it awake forever, which is the bug this
 * replaces.
 *
 * ## Failure
 *
 * Fails open. A gate that cannot be read runs the jobs: being wrong in that
 * direction costs compute, and being wrong in the other leaves a client waiting
 * on work nobody does. It is not silent, though — the cron endpoint reports a
 * gate failure as `degraded`, which turns the GitHub Actions tick red, because
 * a gate that stays broken quietly puts the bill back where it was.
 *
 * Off Netlify (development, tests) there is no gate and every tick runs: PGlite
 * costs nothing to keep awake.
 */

/** However quiet the portal is, the jobs run at least this often. */
export const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * How long one event keeps every tick running.
 *
 * Long enough to cover the follow-up that event implies: a merge's deploy
 * reaching the live site, or a preview alias that Netlify publishes a few
 * minutes after the build reports success. Each later event in the same
 * request's life pushes it out again, so a request in motion keeps it open.
 */
export const WAKE_WINDOW_MS = 45 * 60 * 1000;

/**
 * How long past an agent job's timeout to keep ticking.
 *
 * The watchdog reclaims a job only on a tick *after* its timeout, and ticks are
 * five minutes apart, so the window has to outlast the timeout by more than one
 * tick. Otherwise a silently dead run is noticed by the next sweep, hours
 * later, instead of within minutes.
 */
const WATCHDOG_GRACE_MS = 10 * 60 * 1000;

const STORE_NAME = "scheduler";
const AWAKE_KEY = "awake-until";
const LAST_RUN_KEY = "last-run";

/** Conditional writes to the awake window before giving up on contention. */
const WRITE_ATTEMPTS = 3;

export interface GateState {
  awakeUntil: Date | null;
  lastRunAt: Date | null;
}

export type GateDecision =
  | { run: true; reason: "awake" | "sweep_due" | "ungated" | "unreadable" }
  | {
      run: false;
      reason: "idle";
      awakeUntil: string | null;
      nextSweepAt: string;
    };

/** The decision itself, separated from storage so it can be tested exactly. */
export function decide(state: GateState, now: Date): GateDecision {
  if (state.awakeUntil && state.awakeUntil.getTime() > now.getTime()) {
    return { run: true, reason: "awake" };
  }

  if (
    !state.lastRunAt ||
    now.getTime() - state.lastRunAt.getTime() >= SWEEP_INTERVAL_MS
  ) {
    return { run: true, reason: "sweep_due" };
  }

  return {
    run: false,
    reason: "idle",
    awakeUntil: state.awakeUntil?.toISOString() ?? null,
    nextSweepAt: new Date(
      state.lastRunAt.getTime() + SWEEP_INTERVAL_MS,
    ).toISOString(),
  };
}

interface GateStore {
  get: (key: string, opts: { type: "json" }) => Promise<unknown>;
  getWithMetadata: (
    key: string,
    opts: { type: "json" },
  ) => Promise<{ data: unknown; etag?: string } | null>;
  setJSON: (
    key: string,
    value: unknown,
    opts?: { onlyIfMatch?: string; onlyIfNew?: boolean },
  ) => Promise<{ modified: boolean }>;
}

let store: Promise<GateStore> | undefined;

/**
 * The gate's store, or null where there is no gate.
 *
 * Production uses the global store and everything else a deploy-scoped one, as
 * the storage driver does: a test submission on a deploy preview must not keep
 * production's loop awake, and a preview's sweep must not count as
 * production's.
 *
 * A failed import is not cached, so one bad cold start does not leave the gate
 * unreadable for the rest of the instance's life.
 */
function gateStore(): Promise<GateStore> | null {
  if (!onNetlify()) return null;

  store ??= import("@netlify/blobs")
    .then(
      (m) =>
        (isProductionContext()
          ? m.getStore({ name: STORE_NAME, consistency: "strong" })
          : m.getDeployStore({
              name: STORE_NAME,
              consistency: "strong",
            })) as unknown as GateStore,
    )
    .catch((error: unknown) => {
      store = undefined;
      throw error;
    });

  return store;
}

/** Testing hook: forget the cached store. */
export function resetGateStore(): void {
  store = undefined;
}

function readInstant(value: unknown): Date | null {
  const at = (value as { at?: unknown } | null | undefined)?.at;
  if (typeof at !== "string") return null;
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? null : date;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}

/** Should this tick run the jobs? Never throws. */
export async function checkGate(now: Date = new Date()): Promise<GateDecision> {
  const pending = gateStore();
  if (!pending) return { run: true, reason: "ungated" };

  try {
    const blobs = await pending;
    const [awake, lastRun] = await Promise.all([
      blobs.get(AWAKE_KEY, { type: "json" }),
      blobs.get(LAST_RUN_KEY, { type: "json" }),
    ]);
    return decide(
      { awakeUntil: readInstant(awake), lastRunAt: readInstant(lastRun) },
      now,
    );
  } catch (error) {
    console.error("[scheduler-gate] could not read the gate; running anyway", {
      message: messageOf(error),
    });
    return { run: true, reason: "unreadable" };
  }
}

/**
 * Keep every tick running until `until` — one wake window from now by default.
 *
 * Only ever extends. Two wakes landing together must not let the shorter one
 * overwrite the longer: an agent run's watchdog horizon replaced by a
 * webhook's 45 minutes would leave a dead run unnoticed until the next sweep.
 * So the write is conditional on the value it read, and retried when another
 * writer got there first.
 *
 * Never throws. Every caller is doing something more important — accepting a
 * webhook, dispatching a request — that a scheduling hint must not break.
 * Returns false when the window could not be recorded.
 */
export async function keepSchedulerAwake(
  reason: string,
  until: Date = new Date(Date.now() + WAKE_WINDOW_MS),
): Promise<boolean> {
  const pending = gateStore();
  if (!pending) return true;

  try {
    const blobs = await pending;

    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      const current = await blobs.getWithMetadata(AWAKE_KEY, { type: "json" });
      const existing = readInstant(current?.data);
      if (existing && existing.getTime() >= until.getTime()) return true;

      const condition =
        current === null
          ? { onlyIfNew: true }
          : current.etag
            ? { onlyIfMatch: current.etag }
            : undefined;

      const written = await blobs.setJSON(
        AWAKE_KEY,
        { at: until.toISOString(), reason },
        condition,
      );
      if (written.modified) return true;
    }

    console.error("[scheduler-gate] gave up extending the awake window", {
      reason,
      attempts: WRITE_ATTEMPTS,
    });
    return false;
  } catch (error) {
    console.error("[scheduler-gate] could not keep the scheduler awake", {
      reason,
      message: messageOf(error),
    });
    return false;
  }
}

/** Keep ticking until an agent job's watchdog has had a chance to fire. */
export function keepSchedulerAwakeForJob(timeoutAt: Date): Promise<boolean> {
  return keepSchedulerAwake(
    "agent job watchdog",
    new Date(timeoutAt.getTime() + WATCHDOG_GRACE_MS),
  );
}

/**
 * Record that the jobs ran, which postpones the next sweep.
 *
 * Never throws; returns false when the write failed. A failure here matters
 * more than it looks: with no record of a run, every tick finds the sweep due
 * and runs, which is exactly the always-awake database this gate removed.
 */
export async function recordSchedulerRun(at: Date): Promise<boolean> {
  const pending = gateStore();
  if (!pending) return true;

  try {
    const blobs = await pending;
    await blobs.setJSON(LAST_RUN_KEY, { at: at.toISOString() });
    return true;
  } catch (error) {
    console.error("[scheduler-gate] could not record the run", {
      message: messageOf(error),
    });
    return false;
  }
}
