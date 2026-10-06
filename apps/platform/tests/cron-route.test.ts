import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The scheduled endpoint, as a whole.
 *
 * This file exists because of a merge. Three branches each appended to the one
 * `jobs` array in `api/cron/route.ts` — six jobs became ten — and a merge that
 * kept one side's array would drop the other's work with nothing failing:
 * every test still green, every job simply never running again. Derivatives
 * would stay queued, abandoned uploads would hold quota forever, and lost
 * Stripe webhooks would never be reconciled.
 *
 * So the assertions here are about the array itself, and about the property
 * that makes a ten-job endpoint honest: one job throwing must not take the
 * other nine with it, and the response must say so rather than reporting a
 * healthy run.
 */

const calls: string[] = [];

/** Records that it ran, so a job silently dropped from the array is visible. */
function job(name: string) {
  return vi.fn(async (..._args: unknown[]): Promise<unknown> => {
    calls.push(name);
    return { ran: name };
  });
}

const jobs = {
  dispatchSubmittedRequests: job("dispatchSubmittedRequests"),
  redoChangesRequested: job("redoChangesRequested"),
  expireStalledJobs: job("expireStalledJobs"),
  reverifyPendingPreviews: job("reverifyPendingPreviews"),
  reverifyLiveSites: job("reverifyLiveSites"),
  advanceShippedChanges: job("advanceShippedChanges"),
  expireStaleShares: job("expireStaleShares"),
  runDerivativeJobs: job("runDerivativeJobs"),
  sweepExpiredUploads: job("sweepExpiredUploads"),
  reconcileStorageReservations: job("reconcileStorageReservations"),
  runScheduledReconcile: job("runScheduledReconcile"),
};

const getDb = vi.fn(async () => ({}));

/**
 * The gate, controlled per test. Its default is the sweep being due, so every
 * test above the gate's own section exercises a run exactly as before.
 */
const gate = {
  checkGate: vi.fn(async (): Promise<unknown> => ({ run: true, reason: "sweep_due" })),
  keepSchedulerAwake: vi.fn(async (..._a: unknown[]): Promise<boolean> => true),
  recordSchedulerRun: vi.fn(async (..._a: unknown[]): Promise<boolean> => true),
};

const IDLE = {
  run: false,
  reason: "idle",
  awakeUntil: null,
  nextSweepAt: "2026-10-05T18:00:00.000Z",
};

vi.mock("@/db/client", () => ({ getDb: () => getDb() }));
vi.mock("@/lib/scheduler/gate", () => ({
  checkGate: () => gate.checkGate(),
  keepSchedulerAwake: (...a: unknown[]) => gate.keepSchedulerAwake(...a),
  recordSchedulerRun: (...a: unknown[]) => gate.recordSchedulerRun(...a),
}));
vi.mock("@/db/repositories/admin/agent-jobs", () => ({
  dispatchSubmittedRequests: (...a: unknown[]) => jobs.dispatchSubmittedRequests(...a),
  expireStalledJobs: (...a: unknown[]) => jobs.expireStalledJobs(...a),
}));
vi.mock("@/db/repositories/admin/webhooks", () => ({
  reverifyPendingPreviews: (...a: unknown[]) => jobs.reverifyPendingPreviews(...a),
}));
vi.mock("@/db/repositories/admin/revisions", () => ({
  redoChangesRequested: (...a: unknown[]) => jobs.redoChangesRequested(...a),
}));
vi.mock("@/db/repositories/admin/launch", () => ({
  reverifyLiveSites: (...a: unknown[]) => jobs.reverifyLiveSites(...a),
}));
vi.mock("@/db/repositories/admin/shipped", () => ({
  advanceShippedChanges: (...a: unknown[]) => jobs.advanceShippedChanges(...a),
}));
vi.mock("@/db/repositories/admin/maintenance", () => ({
  expireStaleShares: (...a: unknown[]) => jobs.expireStaleShares(...a),
}));
vi.mock("@/db/repositories/admin/media-jobs", () => ({
  runDerivativeJobs: (...a: unknown[]) => jobs.runDerivativeJobs(...a),
}));
vi.mock("@/db/repositories/client/media-uploads", () => ({
  sweepExpiredUploads: (...a: unknown[]) => jobs.sweepExpiredUploads(...a),
}));
vi.mock("@/db/repositories/client/media-quota", () => ({
  reconcileStorageReservations: (...a: unknown[]) => jobs.reconcileStorageReservations(...a),
}));
vi.mock("@/db/repositories/admin/stripe-reconcile", () => ({
  runScheduledReconcile: (...a: unknown[]) => jobs.runScheduledReconcile(...a),
}));

const SECRET = "test-cron-secret";

/** Every result key the endpoint is expected to report, by feature. */
const LOOP_KEYS = [
  "requestsDispatched",
  "changesRedone",
  "previewsVerified",
  "jobsExpired",
  "shippedChanges",
  "liveSiteProblems",
  "sharesExpired",
];
const MEDIA_KEYS = ["mediaDerivatives", "mediaUploadsSwept", "storageReconciled"];
const STRIPE_KEYS = ["stripeReconciled"];
const ALL_KEYS = [...LOOP_KEYS, ...MEDIA_KEYS, ...STRIPE_KEYS];

function request(
  secret: string | null = SECRET,
  extra: Record<string, string> = {},
) {
  return new Request("https://portal.example.com/api/cron", {
    method: "POST",
    headers: { ...(secret ? { "x-cron-secret": secret } : {}), ...extra },
  });
}

async function post(
  secret: string | null = SECRET,
  extra: Record<string, string> = {},
) {
  const { POST } = await import("@/app/api/cron/route");
  return POST(request(secret, extra));
}

beforeEach(() => {
  calls.length = 0;
  for (const fn of Object.values(jobs)) fn.mockClear();
  // Reset rather than clear: a test's "once" answer must not leak into the
  // next, and resetting a `vi.fn(impl)` restores `impl`.
  for (const fn of Object.values(gate)) fn.mockReset();
  getDb.mockClear();
  vi.stubEnv("CRON_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the scheduled endpoint", () => {
  it("runs every job the three features registered", async () => {
    const response = await post();
    const body = await response.json();

    expect(response.status).toBe(200);
    // Named individually rather than by count: a count assertion passes when
    // one job is swapped for another, which is exactly the merge accident.
    for (const key of ALL_KEYS) expect(body).toHaveProperty(key);
    expect(calls).toHaveLength(Object.keys(jobs).length);
  });

  it("reports a healthy run as not degraded", async () => {
    const body = await (await post()).json();

    expect(body.ok).toBe(true);
    expect(body.degraded).toBe(false);
    expect(body.failedJobs).toEqual([]);
  });

  it("keeps a failed job visible instead of reporting a healthy run", async () => {
    jobs.runDerivativeJobs.mockRejectedValueOnce(new Error("sharp fell over"));

    const response = await post();
    const body = await response.json();

    // Still 200 and still `ok`: the endpoint ran. `degraded` is the honest
    // signal beside it, and swallowing it is how a broken job goes unnoticed
    // for a week.
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.degraded).toBe(true);
    expect(body.failedJobs).toEqual(["mediaDerivatives"]);
    expect(body.mediaDerivatives).toEqual({ error: "sharp fell over" });
  });

  it("runs the remaining jobs after one throws", async () => {
    jobs.reverifyPendingPreviews.mockRejectedValueOnce(new Error("netlify down"));

    const body = await (await post()).json();

    expect(body.failedJobs).toEqual(["previewsVerified"]);
    // The point of isolating them: a Netlify outage must not also stop media
    // derivatives or Stripe reconciliation.
    for (const key of [...MEDIA_KEYS, ...STRIPE_KEYS]) {
      expect(body[key]).not.toHaveProperty("error");
    }
    expect(calls).toContain("runDerivativeJobs");
    expect(calls).toContain("runScheduledReconcile");
  });

  it("names every failure when several jobs throw", async () => {
    jobs.sweepExpiredUploads.mockRejectedValueOnce(new Error("one"));
    jobs.runScheduledReconcile.mockRejectedValueOnce(new Error("two"));

    const body = await (await post()).json();

    expect(body.degraded).toBe(true);
    expect(body.failedJobs).toEqual(["mediaUploadsSwept", "stripeReconciled"]);
  });

  it("refuses, and runs nothing, without the shared secret", async () => {
    const response = await post("wrong-secret");

    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("refuses when CRON_SECRET is unset rather than running open", async () => {
    vi.stubEnv("CRON_SECRET", "");

    const response = await post(null);

    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });
});

/**
 * The gate. A five-minute tick that always ran kept Neon awake around the clock
 * and spent the month's compute by the middle of it, so the property here is
 * that an idle tick never reaches the database — not merely that it runs no
 * jobs. Opening a connection is what keeps the compute up.
 */
describe("the scheduled endpoint's gate", () => {
  it("answers an idle tick without touching the database", async () => {
    gate.checkGate.mockResolvedValueOnce(IDLE);

    const response = await post();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      degraded: false,
      failedJobs: [],
      skipped: true,
      gate: "idle",
      nextSweepAt: IDLE.nextSweepAt,
    });
    expect(getDb).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(gate.recordSchedulerRun).not.toHaveBeenCalled();
  });

  it("runs a nudge even when idle, and keeps the following ticks running", async () => {
    gate.checkGate.mockResolvedValue(IDLE);

    const body = await (
      await post(SECRET, { "x-nudge-reason": "request submitted" })
    ).json();

    expect(body.gate).toBe("nudged");
    expect(calls).toHaveLength(Object.keys(jobs).length);
    expect(gate.keepSchedulerAwake).toHaveBeenCalledWith(
      "nudge: request submitted",
    );
    // A nudge is an event; the gate's idle answer is not consulted.
    expect(gate.checkGate).not.toHaveBeenCalled();
  });

  it("runs a forced call when idle, for diagnosing by hand", async () => {
    gate.checkGate.mockResolvedValue(IDLE);

    const body = await (await post(SECRET, { "x-cron-force": "1" })).json();

    expect(body.gate).toBe("forced");
    expect(calls).toHaveLength(Object.keys(jobs).length);
    expect(gate.checkGate).not.toHaveBeenCalled();
    // Diagnosing must not itself hold the database awake for 45 minutes.
    expect(gate.keepSchedulerAwake).not.toHaveBeenCalled();
  });

  it("records the run once the jobs have finished", async () => {
    const body = await (await post()).json();

    expect(body.gate).toBe("sweep_due");
    expect(gate.recordSchedulerRun).toHaveBeenCalledTimes(1);
    expect(gate.recordSchedulerRun.mock.calls[0]![0]).toBeInstanceOf(Date);
  });

  it("runs the jobs when the gate cannot be read, but reports it as degraded", async () => {
    gate.checkGate.mockResolvedValueOnce({ run: true, reason: "unreadable" });

    const body = await (await post()).json();

    // Failing open keeps the work happening; reporting it keeps the cost from
    // quietly returning. The Actions tick turns red on `degraded`.
    expect(calls).toHaveLength(Object.keys(jobs).length);
    expect(body.degraded).toBe(true);
    expect(body.failedJobs).toEqual(["schedulerGate"]);
  });

  it("reports a run it could not record, since every later tick would then run", async () => {
    gate.recordSchedulerRun.mockResolvedValueOnce(false);

    const body = await (await post()).json();

    expect(body.degraded).toBe(true);
    expect(body.failedJobs).toEqual(["schedulerGate"]);
  });

  it("reports a nudge whose window could not be held open", async () => {
    gate.keepSchedulerAwake.mockResolvedValueOnce(false);

    const body = await (
      await post(SECRET, { "x-nudge-reason": "change approved" })
    ).json();

    expect(calls).toHaveLength(Object.keys(jobs).length);
    expect(body.failedJobs).toEqual(["schedulerGate"]);
  });

  it("consults no gate for a caller without the secret", async () => {
    await post("wrong-secret", { "x-nudge-reason": "spoofed" });

    expect(gate.checkGate).not.toHaveBeenCalled();
    expect(gate.keepSchedulerAwake).not.toHaveBeenCalled();
  });
});
