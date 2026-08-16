import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { StorageDriver, StoredObject } from "./index";

/**
 * Driver selection.
 *
 * Local disk in development, and nothing else implemented yet — the production
 * driver waits on the deploy-target decision (R2 binding, Netlify Blobs, or the
 * S3 API). `storageDriver()` throws rather than silently falling back to disk in
 * production, because a serverless filesystem is ephemeral: uploads would appear
 * to work, then vanish when the instance recycled. A loud failure at boot is a
 * far better outcome than a client's photos disappearing a day later.
 */

const LOCAL_ROOT = process.env.ATTACHMENT_DIR ?? "./.attachments";

/** Keys we generate: two hex segments and an extension. Nothing else is valid. */
const KEY_PATTERN = /^[0-9a-f]{2}\/[0-9a-f]{32}\.[a-z0-9]{1,5}$/;

/**
 * Reject anything that is not a key this system generated.
 *
 * The stored key never comes from user input, so this should be unreachable.
 * It is here because "should be unreachable" is exactly the assumption that
 * turns a refactor into a path traversal, and the containment check below is
 * cheap insurance.
 */
function assertSafeKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new Error("Refusing to touch a storage key that is not well-formed.");
  }
}

function resolveWithin(root: string, key: string): string {
  const base = resolve(root);
  const full = resolve(join(base, key));
  // Belt and braces: even a well-formed key must land inside the root.
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error("Resolved storage path escaped the attachment root.");
  }
  return full;
}

class LocalDiskDriver implements StorageDriver {
  constructor(private readonly root: string) {}

  async put(input: {
    key: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<StoredObject> {
    assertSafeKey(input.key);
    const path = resolveWithin(this.root, input.key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.bytes);
    return {
      key: input.key,
      size: input.bytes.byteLength,
      contentType: input.contentType,
    };
  }

  async get(
    key: string,
  ): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    assertSafeKey(key);
    try {
      const bytes = await readFile(resolveWithin(this.root, key));
      // The authoritative content type lives in the database row, sniffed at
      // upload. The caller supplies it; disk knows only bytes.
      return { bytes: new Uint8Array(bytes), contentType: "application/octet-stream" };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    await rm(resolveWithin(this.root, key), { force: true });
  }
}

/**
 * Netlify Blobs.
 *
 * The package is imported dynamically for the same reason PGlite is: it must
 * not be pulled into a build that will never use it, and it is only resolvable
 * when running on Netlify.
 *
 * Content type is NOT stored here. The authoritative value lives in the
 * `request_attachments` row, sniffed from the bytes at upload — trusting
 * metadata round-tripped through storage would reintroduce exactly the trust
 * the upload validator exists to remove.
 */
class NetlifyBlobsDriver implements StorageDriver {
  private store: Promise<{
    set: (key: string, value: ArrayBuffer | Uint8Array) => Promise<unknown>;
    get: (key: string, opts: { type: "arrayBuffer" }) => Promise<ArrayBuffer | null>;
    delete: (key: string) => Promise<unknown>;
  }>;

  constructor() {
    this.store = import("@netlify/blobs").then((m) =>
      m.getStore({ name: "attachments", consistency: "strong" }),
    ) as never;
  }

  async put(input: {
    key: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<StoredObject> {
    assertSafeKey(input.key);
    const store = await this.store;
    await store.set(input.key, input.bytes);
    return {
      key: input.key,
      size: input.bytes.byteLength,
      contentType: input.contentType,
    };
  }

  async get(
    key: string,
  ): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    assertSafeKey(key);
    const store = await this.store;
    const buffer = await store.get(key, { type: "arrayBuffer" });
    if (!buffer) return null;
    return {
      bytes: new Uint8Array(buffer),
      contentType: "application/octet-stream",
    };
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    const store = await this.store;
    await store.delete(key);
  }
}

let cached: StorageDriver | undefined;

/**
 * Pick a driver.
 *
 * Netlify sets `NETLIFY` in its build and function runtimes, which is what
 * distinguishes "deployed" from "someone ran a production build locally".
 * Production without a real object store still throws rather than falling back
 * to disk: a serverless filesystem is ephemeral, so uploads would appear to
 * succeed and then vanish when the instance recycled — far worse than a loud
 * failure at startup.
 */
export function storageDriver(): StorageDriver {
  if (cached) return cached;

  if (process.env.NETLIFY) {
    cached = new NetlifyBlobsDriver();
    return cached;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "No production storage driver is configured. Attachments require " +
        "Netlify Blobs, R2, or S3 — the local disk driver is development only " +
        "and would lose uploads when the instance recycles.",
    );
  }

  cached = new LocalDiskDriver(LOCAL_ROOT);
  return cached;
}

/**
 * A fresh object key: a two-character shard prefix and 128 bits of randomness.
 *
 * The shard keeps a local directory listing manageable and costs nothing on an
 * object store. The submitted filename contributes nothing to this value.
 */
export function newStorageKey(extension: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 2)}/${hex}.${extension}`;
}
