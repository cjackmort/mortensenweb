import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Netlify Blobs driver across invocations.
 *
 * Netlify issues the Blobs token per invocation, and `getStore` copies it into
 * the client it builds. The drivers are cached for the life of the function
 * instance, so a driver that also cached its store kept presenting the first
 * token after it expired. The scheduler gate had exactly this bug and failed
 * every read from about twenty minutes into each hour; here it would fail
 * uploads, derivative jobs, signed reads and the sweeper on any warm instance.
 *
 * Blobs is replaced by one in-memory store per token, all sharing the same
 * entries, so an expired token fails and a fresh one sees everything.
 */

class TokenStore {
  expired = false;

  constructor(private readonly entries: Map<string, Uint8Array>) {}

  async set(key: string, value: Uint8Array) {
    if (this.expired) throw new Error("401: token expired");
    this.entries.set(key, new Uint8Array(value));
  }

  async get(key: string) {
    if (this.expired) throw new Error("401: token expired");
    const value = this.entries.get(key);
    return value ? value.slice().buffer : null;
  }

  async delete(key: string) {
    if (this.expired) throw new Error("401: token expired");
    this.entries.delete(key);
  }
}

let entries = new Map<string, Uint8Array>();
let byToken = new Map<string, TokenStore>();

function storeForThisInvocation(): TokenStore {
  const token = process.env.NETLIFY_BLOBS_CONTEXT ?? "";
  let store = byToken.get(token);
  if (!store) {
    store = new TokenStore(entries);
    byToken.set(token, store);
  }
  return store;
}

const getStore = vi.fn((..._args: unknown[]) => storeForThisInvocation());
const getDeployStore = vi.fn((..._args: unknown[]) => storeForThisInvocation());

vi.mock("@netlify/blobs", () => ({
  getStore: (...args: unknown[]) => getStore(...args),
  getDeployStore: (...args: unknown[]) => getDeployStore(...args),
}));

const { mediaDriver, originalKey, resetStorageDrivers } = await import(
  "@/lib/storage/driver"
);
const { newPublicId } = await import("@/lib/ids");

const NETLIFY_VARS = [
  "NETLIFY",
  "NETLIFY_BLOBS_CONTEXT",
  "DEPLOY_ID",
  "SITE_ID",
  "URL",
] as const;

function invocation(token: string, context: string) {
  for (const key of NETLIFY_VARS) vi.stubEnv(key, "");
  vi.stubEnv("NETLIFY_BLOBS_CONTEXT", token);
  vi.stubEnv("CONTEXT", context);
}

const bytes = (...values: number[]) => new Uint8Array(values);

beforeEach(() => {
  entries = new Map();
  byToken = new Map();
  getStore.mockClear();
  getDeployStore.mockClear();
  resetStorageDrivers();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetStorageDrivers();
});

describe("the Blobs driver on a warm instance", () => {
  it.each([
    ["production", getStore],
    ["deploy-preview", getDeployStore],
  ])(
    "uses each invocation's own token in %s, not the first one it saw",
    async (context, builder) => {
      invocation("first-invocation", context);
      const driver = mediaDriver();
      const first = originalKey(newPublicId(), "jpg");
      await driver.put({ key: first, bytes: bytes(1, 2, 3), contentType: "image/jpeg" });
      expect((await driver.get(first))?.bytes).toEqual(bytes(1, 2, 3));

      // That token expires; the next invocation arrives with a new one and
      // finds the same driver, because drivers are cached per instance.
      byToken.get("first-invocation")!.expired = true;
      invocation("later-invocation", context);
      expect(mediaDriver()).toBe(driver);

      const second = originalKey(newPublicId(), "jpg");
      await driver.put({ key: second, bytes: bytes(4, 5), contentType: "image/jpeg" });
      expect((await driver.get(second))?.bytes).toEqual(bytes(4, 5));
      expect((await driver.get(first))?.bytes).toEqual(bytes(1, 2, 3));
      await driver.delete(first);
      expect(await driver.get(first)).toBeNull();

      // The production / preview split still holds on every call.
      expect(builder).toHaveBeenCalled();
      expect(builder === getStore ? getDeployStore : getStore).not.toHaveBeenCalled();
    },
  );
});
