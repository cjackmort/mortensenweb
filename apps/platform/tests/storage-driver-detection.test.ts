import { afterEach, describe, expect, it, vi } from "vitest";
import { mediaDriver, resetStorageDrivers, storageDriver } from "@/lib/storage/driver";

/**
 * Deciding whether we are on Netlify.
 *
 * This was checked with `process.env.NETLIFY`, which Netlify sets in the
 * *build* environment and not in the Functions runtime. Both drivers therefore
 * fell through to the production guard and threw "no production storage driver
 * is configured" on every call. Nine upload sessions in production stored zero
 * parts, every asset stuck reading "Preparing…", and it looked for days like a
 * Netlify Blobs failure — the Blobs driver was never constructed.
 *
 * A false negative here does not degrade; it takes the whole media library
 * down. So the detection is asserted directly rather than inferred from an
 * upload working.
 */

const NETLIFY_VARS = [
  "NETLIFY",
  "NETLIFY_BLOBS_CONTEXT",
  "DEPLOY_ID",
  "SITE_ID",
  "URL",
] as const;

function clearNetlify() {
  for (const key of NETLIFY_VARS) vi.stubEnv(key, "");
  vi.stubEnv("CONTEXT", "");
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetStorageDrivers();
});

describe("choosing a storage backend", () => {
  it.each(NETLIFY_VARS)(
    "recognises the Netlify runtime from %s alone",
    (marker) => {
      clearNetlify();
      resetStorageDrivers();
      vi.stubEnv(marker, "something");
      vi.stubEnv("NODE_ENV", "production");

      // The bug was that only one of these was consulted, and it was the one
      // absent at runtime. Any single marker must be enough.
      expect(() => mediaDriver()).not.toThrow();
      resetStorageDrivers();
      expect(() => storageDriver()).not.toThrow();
    },
  );

  it("still refuses to use local disk in production when nothing says Netlify", () => {
    clearNetlify();
    resetStorageDrivers();
    vi.stubEnv("NODE_ENV", "production");

    // The guard itself is right and stays: a serverless filesystem is
    // ephemeral, so falling back to disk would accept a client's original and
    // lose it when the instance recycled. Loud is correct here.
    expect(() => mediaDriver()).toThrow(/no production storage driver/i);
  });

  it("falls back to local disk outside production, as development needs", () => {
    clearNetlify();
    resetStorageDrivers();
    vi.stubEnv("NODE_ENV", "development");

    expect(() => mediaDriver()).not.toThrow();
  });
});
