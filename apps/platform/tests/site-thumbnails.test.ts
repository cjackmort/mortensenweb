import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "@/db/client";
import { organizations, sites } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { resetStorageDrivers } from "@/lib/storage/driver";
import {
  hasCronSecret,
  listThumbnailTargets,
  readThumbnail,
  saveThumbnail,
} from "@/lib/thumbnails";
import { createTestDb } from "./helpers/db";

/**
 * Pictures of client home pages, taken by a scheduled job and shown on the
 * admin tiles. What matters: only the job can write them, only a JPEG of a
 * site we know is stored, and the job is only pointed at real sites.
 */

let db: Database;
let close: () => Promise<void>;
let dir: string;

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function addSite(values: Partial<typeof sites.$inferInsert>) {
  const org = (
    await db
      .insert(organizations)
      .values({ publicId: newPublicId(), name: "Org", slug: `org-${newPublicId().toLowerCase()}`, kind: "client" })
      .returning()
  )[0]!;
  return (
    await db
      .insert(sites)
      .values({ publicId: newPublicId(), organizationId: org.id, name: "Site", ...values })
      .returning()
  )[0]!;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  dir = await mkdtemp(join(tmpdir(), "thumbs-"));
  process.env.THUMBNAIL_DIR = dir;
  resetStorageDrivers();
});

afterAll(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.delete(sites);
  process.env.CRON_SECRET = "s3cret-value";
});

describe("hasCronSecret", () => {
  it("accepts the shared secret and nothing else", () => {
    const ok = new Request("https://p.test", { headers: { "x-cron-secret": "s3cret-value" } });
    const wrong = new Request("https://p.test", { headers: { "x-cron-secret": "nope" } });
    const none = new Request("https://p.test");
    expect([hasCronSecret(ok), hasCronSecret(wrong), hasCronSecret(none)]).toEqual([true, false, false]);
  });

  it("refuses everyone when no secret is configured", () => {
    delete process.env.CRON_SECRET;
    const empty = new Request("https://p.test", { headers: { "x-cron-secret": "" } });
    expect(hasCronSecret(empty)).toBe(false);
  });
});

describe("listThumbnailTargets", () => {
  it("lists sites that have an address, at that address", async () => {
    const domain = await addSite({ primaryDomain: "northwind.example" });
    const netlify = await addSite({ netlifySiteName: "acme-demo" });
    await addSite({});

    const targets = await listThumbnailTargets(db);

    expect(targets).toEqual(
      expect.arrayContaining([
        { publicId: domain.publicId, url: "https://northwind.example" },
        { publicId: netlify.publicId, url: "https://acme-demo.netlify.app" },
      ]),
    );
    expect(targets).toHaveLength(2);
  });

  it("skips archived sites and sites shown live", async () => {
    await addSite({ primaryDomain: "gone.example", archivedAt: new Date() });
    await addSite({ primaryDomain: "moving.example", previewMode: "live" });
    expect(await listThumbnailTargets(db)).toEqual([]);
  });
});

describe("saveThumbnail and readThumbnail", () => {
  it("stores a JPEG for a known site and reads it back", async () => {
    const site = await addSite({ primaryDomain: "northwind.example" });

    expect(await saveThumbnail(db, site.publicId, JPEG)).toEqual({ ok: true });
    expect((await readThumbnail(site.publicId))?.bytes).toEqual(JPEG);
  });

  it("refuses anything that is not a JPEG", async () => {
    const site = await addSite({ primaryDomain: "northwind.example" });
    expect(await saveThumbnail(db, site.publicId, PNG)).toEqual({ ok: false, reason: "not_jpeg" });
  });

  it("refuses an oversized picture", async () => {
    const site = await addSite({ primaryDomain: "northwind.example" });
    const huge = new Uint8Array(3 * 1024 * 1024);
    huge.set(JPEG);
    expect(await saveThumbnail(db, site.publicId, huge)).toEqual({ ok: false, reason: "too_large" });
  });

  it("refuses a site that does not exist, or an id that is not one", async () => {
    expect(await saveThumbnail(db, newPublicId(), JPEG)).toEqual({ ok: false, reason: "unknown_site" });
    expect(await saveThumbnail(db, "../../etc/passwd", JPEG)).toEqual({ ok: false, reason: "unknown_site" });
    expect(await readThumbnail("../../etc/passwd")).toBeNull();
  });
});
