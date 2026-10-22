import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/db/client";
import { mediaAssets, showcasePhotos, showcases } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * Migration 0033: the constraints that keep a showcase honest.
 *
 * Each of these is a rule the application also follows, held here as well so
 * a future code path cannot forget it.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  acme = await seedTenant(db, "Acme Heating");
});

afterAll(async () => {
  await close();
});

function draft(overrides: Partial<typeof showcases.$inferInsert> = {}) {
  return {
    publicId: newPublicId(),
    organizationId: acme.organizationId,
    job: "Replaced a furnace",
    town: "Riverton",
    title: "Replaced a furnace in Riverton",
    writeUp: "We replaced a furnace in Riverton.",
    caption: "Replaced a furnace in Riverton.",
    ...overrides,
  };
}

async function asset(): Promise<string> {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      publicId: newPublicId(),
      organizationId: acme.organizationId,
      originalFilename: "job.jpg",
    })
    .returning({ id: mediaAssets.id });
  return row!.id;
}

describe("showcases", () => {
  it("starts a new showcase as a draft", async () => {
    const [row] = await db.insert(showcases).values(draft()).returning();
    expect(row!.status).toBe("draft");
    expect(row!.googleStatus).toBeNull();
  });

  it("refuses an approval with no approval time", async () => {
    await expect(db.insert(showcases).values(draft({ status: "approved" }))).rejects.toThrow();
  });

  it("refuses a status it does not know", async () => {
    await expect(db.insert(showcases).values(draft({ status: "published" }))).rejects.toThrow();
  });

  it("refuses a Google status it does not know", async () => {
    await expect(db.insert(showcases).values(draft({ googleStatus: "queued" }))).rejects.toThrow();
  });

  it("refuses a site blocked reason it does not know", async () => {
    await expect(db.insert(showcases).values(draft({ siteBlockedReason: "busy" }))).rejects.toThrow();
  });
});

describe("showcase photos", () => {
  it("allows one before and one after per showcase, and any number of plain photos", async () => {
    const [showcase] = await db.insert(showcases).values(draft()).returning({ id: showcases.id });
    const ids = await Promise.all([asset(), asset(), asset(), asset()]);

    await db.insert(showcasePhotos).values([
      { showcaseId: showcase!.id, assetId: ids[0]!, position: 0, role: "before" },
      { showcaseId: showcase!.id, assetId: ids[1]!, position: 1, role: "after" },
      { showcaseId: showcase!.id, assetId: ids[2]!, position: 2, role: "photo" },
    ]);

    await expect(
      db.insert(showcasePhotos).values({ showcaseId: showcase!.id, assetId: ids[3]!, role: "before" }),
    ).rejects.toThrow();
    await db.insert(showcasePhotos).values({ showcaseId: showcase!.id, assetId: ids[3]!, role: "photo" });
  });

  it("refuses the same photo twice in one showcase", async () => {
    const [showcase] = await db.insert(showcases).values(draft()).returning({ id: showcases.id });
    const id = await asset();
    await db.insert(showcasePhotos).values({ showcaseId: showcase!.id, assetId: id });
    await expect(db.insert(showcasePhotos).values({ showcaseId: showcase!.id, assetId: id })).rejects.toThrow();
  });
});
