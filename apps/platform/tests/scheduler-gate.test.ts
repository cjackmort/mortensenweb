import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The scheduler's gate.
 *
 * It exists because a five-minute tick that always queried kept Neon awake
 * around the clock and spent the month's compute by the middle of it. The
 * property that matters is the one nobody would notice breaking: an idle portal
 * makes no database call at all, while an event still keeps every tick running
 * for as long as its follow-ups need.
 *
 * Blobs is replaced by an in-memory store that honours the same conditional
 * writes, because the "only ever extends" guarantee lives entirely in those.
 */

class FakeStore {
  entries = new Map<string, { value: unknown; etag: string }>();
  version = 0;
  failing = false;
  writes = 0;
  /** Runs once, between a read and the next write — a concurrent writer. */
  interleave?: () => void;

  async get(key: string): Promise<unknown> {
    if (this.failing) throw new Error("blobs is down");
    return this.entries.get(key)?.value ?? null;
  }

  async getWithMetadata(key: string) {
    if (this.failing) throw new Error("blobs is down");
    const entry = this.entries.get(key);
    return entry ? { data: entry.value, etag: entry.etag, metadata: {} } : null;
  }

  async setJSON(
    key: string,
    value: unknown,
    opts: { onlyIfMatch?: string; onlyIfNew?: boolean } = {},
  ) {
    if (this.failing) throw new Error("blobs is down");
    const interleave = this.interleave;
    this.interleave = undefined;
    interleave?.();

    const entry = this.entries.get(key);
    if (opts.onlyIfNew && entry) return { modified: false };
    if (opts.onlyIfMatch && entry?.etag !== opts.onlyIfMatch) {
      return { modified: false };
    }
    this.writes += 1;
    this.put(key, value);
    return { modified: true };
  }

  put(key: string, value: unknown) {
    this.version += 1;
    this.entries.set(key, {
      value: JSON.parse(JSON.stringify(value)),
      etag: `"${this.version}"`,
    });
  }
}

let globalStore = new FakeStore();
let deployStore = new FakeStore();
const getStore = vi.fn((..._args: unknown[]) => globalStore);
const getDeployStore = vi.fn((..._args: unknown[]) => deployStore);

vi.mock("@netlify/blobs", () => ({
  getStore: (...args: unknown[]) => getStore(...args),
  getDeployStore: (...args: unknown[]) => getDeployStore(...args),
}));

const {
  SWEEP_INTERVAL_MS,
  checkGate,
  decide,
  keepSchedulerAwake,
  keepSchedulerAwakeForJob,
  recordSchedulerRun,
  resetGateStore,
} = await import("@/lib/scheduler/gate");

const T0 = new Date("2026-10-05T12:00:00.000Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
const hours = (n: number) => minutes(n * 60);

const NETLIFY_VARS = [
  "NETLIFY",
  "NETLIFY_BLOBS_CONTEXT",
  "DEPLOY_ID",
  "SITE_ID",
  "URL",
] as const;

function offNetlify() {
  for (const key of NETLIFY_VARS) vi.stubEnv(key, "");
}

function onNetlify(context = "production") {
  offNetlify();
  vi.stubEnv("NETLIFY_BLOBS_CONTEXT", "present");
  vi.stubEnv("CONTEXT", context);
}

function awakeUntil(store = globalStore): string | undefined {
  return (store.entries.get("awake-until")?.value as { at?: string })?.at;
}

beforeEach(() => {
  globalStore = new FakeStore();
  deployStore = new FakeStore();
  getStore.mockClear();
  getDeployStore.mockClear();
  resetGateStore();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("deciding whether a tick runs", () => {
  it("runs while an event's window is open, however recent the last run", () => {
    expect(
      decide({ awakeUntil: minutes(30), lastRunAt: minutes(-1) }, T0),
    ).toEqual({ run: true, reason: "awake" });
  });

  it("skips when the window has closed and the last run is recent", () => {
    expect(
      decide({ awakeUntil: minutes(-1), lastRunAt: hours(-1) }, T0),
    ).toEqual({
      run: false,
      reason: "idle",
      awakeUntil: minutes(-1).toISOString(),
      nextSweepAt: hours(5).toISOString(),
    });
  });

  it("runs the sweep once the last run is six hours old", () => {
    expect(
      decide({ awakeUntil: null, lastRunAt: new Date(T0.getTime() - SWEEP_INTERVAL_MS) }, T0),
    ).toEqual({ run: true, reason: "sweep_due" });
    expect(
      decide({ awakeUntil: null, lastRunAt: new Date(T0.getTime() - SWEEP_INTERVAL_MS + 1) }, T0)
        .run,
    ).toBe(false);
  });

  it("runs when there is no record of any run, so a first deploy is not idle", () => {
    expect(decide({ awakeUntil: null, lastRunAt: null }, T0)).toEqual({
      run: true,
      reason: "sweep_due",
    });
  });
});

describe("the gate on Netlify", () => {
  it("lets an idle portal's ticks skip, and an event reopen them", async () => {
    onNetlify();

    // A run happens; five minutes later nothing has happened since.
    expect(await recordSchedulerRun(T0)).toBe(true);
    expect((await checkGate(minutes(5))).run).toBe(false);

    // A client submits at +20: ticks run through the 45-minute window...
    expect(await keepSchedulerAwake("request submitted", minutes(65))).toBe(true);
    expect(await checkGate(minutes(25))).toEqual({ run: true, reason: "awake" });
    expect((await checkGate(minutes(64))).run).toBe(true);

    // ...and stop once it has closed and those runs are recorded.
    await recordSchedulerRun(minutes(60));
    expect((await checkGate(minutes(70))).run).toBe(false);
  });

  it("never shortens the window: a later, shorter wake leaves the longer one", async () => {
    onNetlify();

    await keepSchedulerAwake("agent job watchdog", minutes(40));
    await keepSchedulerAwake("github pull_request", minutes(10));

    expect(awakeUntil()).toBe(minutes(40).toISOString());
  });

  it("does not lose a longer wake that lands between its read and its write", async () => {
    onNetlify();
    await keepSchedulerAwake("first", minutes(5));

    // Between this call reading 5 and writing 20, another writer sets 60.
    globalStore.interleave = () =>
      globalStore.put("awake-until", { at: minutes(60).toISOString(), reason: "racer" });

    expect(await keepSchedulerAwake("slower", minutes(20))).toBe(true);
    expect(awakeUntil()).toBe(minutes(60).toISOString());
  });

  it("holds the loop awake past an agent job's timeout, so the watchdog gets a tick", async () => {
    onNetlify();

    await keepSchedulerAwakeForJob(minutes(30));

    // Ticks are five minutes apart; the window must outlast the timeout by more.
    const until = new Date(awakeUntil()!);
    expect(until.getTime() - minutes(30).getTime()).toBeGreaterThan(5 * 60_000);
  });

  it("fails open when Blobs cannot be read, and says so", async () => {
    onNetlify();
    globalStore.failing = true;

    expect(await checkGate(T0)).toEqual({ run: true, reason: "unreadable" });
    expect(console.error).toHaveBeenCalled();
  });

  it("reports a failed write instead of throwing into the caller", async () => {
    onNetlify();
    globalStore.failing = true;

    await expect(keepSchedulerAwake("github pull_request")).resolves.toBe(false);
    await expect(recordSchedulerRun(T0)).resolves.toBe(false);
  });

  it("keeps a deploy preview's gate apart from production's", async () => {
    onNetlify("deploy-preview");

    await keepSchedulerAwake("preview test submit", minutes(45));

    expect(getDeployStore).toHaveBeenCalled();
    expect(getStore).not.toHaveBeenCalled();
    expect(awakeUntil(deployStore)).toBe(minutes(45).toISOString());
    expect(globalStore.entries.size).toBe(0);
  });
});

describe("off Netlify", () => {
  it("has no gate: every tick runs, and nothing is written", async () => {
    offNetlify();

    expect(await checkGate(T0)).toEqual({ run: true, reason: "ungated" });
    expect(await keepSchedulerAwake("request submitted")).toBe(true);
    expect(await recordSchedulerRun(T0)).toBe(true);
    expect(getStore).not.toHaveBeenCalled();
    expect(getDeployStore).not.toHaveBeenCalled();
  });
});
