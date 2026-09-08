import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  changeAllowances,
  changeRequests,
  mediaAssets,
  mediaUsages,
  requestAssets,
  servicePlans,
  sites,
  subscriptions,
} from "@/db/schema";
import {
  createChangeRequest,
  findRequestByIdempotencyKey,
} from "@/db/repositories/client/change-requests";
import {
  attachAssetsToRequest,
  listRequestAssets,
  markUsagePublished,
  releaseUsage,
  snapshotRequestAssets,
  validateAssetSelection,
} from "@/db/repositories/client/request-assets";
import { trashAssets, getAssetUsage } from "@/db/repositories/client/media-assets";
import { consumeChange, refundChange } from "@/db/repositories/client/entitlements";
import { createFolder } from "@/db/repositories/client/media-folders";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * Requests carrying library images.
 *
 * The cases that matter are the accounting ones. A client who double-taps Send
 * on a slow connection must end up with one request and one change spent, and
 * an image already promised to a request must not be deletable out from under
 * it. Both are the kind of bug that is invisible until someone is billed
 * wrongly or an agent run fails with a missing file.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let globex: SeededTenant;
let siteId: string;

/** A ready asset, without going through the whole upload path. */
async function makeReadyAsset(
  tenant: SeededTenant,
  name: string,
  overrides: Partial<{
    title: string;
    description: string;
    width: number;
    height: number;
    folderId: string;
    status: "ready" | "processing" | "failed";
  }> = {},
): Promise<string> {
  const publicId = newPublicId();
  await db.insert(mediaAssets).values({
    publicId,
    organizationId: tenant.organizationId,
    status: overrides.status ?? "ready",
    storageKey: `a/${publicId}/original.jpg`,
    originalFilename: name,
    contentType: "image/jpeg",
    byteSize: 2048,
    checksumSha256: "b".repeat(64),
    width: overrides.width ?? 1600,
    height: overrides.height ?? 1200,
    orientation: 1,
    title: overrides.title ?? null,
    description: overrides.description ?? null,
    folderId: overrides.folderId ?? null,
  });
  return publicId;
}

async function makeRequest(tenant: SeededTenant, title: string, key?: string) {
  return createChangeRequest(db, tenant.ctx, {
    title,
    idempotencyKey: key,
  });
}

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  acme = await seedTenant(db, "Acme");
  globex = await seedTenant(db, "Globex");

  const siteRows = await db
    .insert(sites)
    .values({
      publicId: newPublicId(),
      organizationId: acme.organizationId,
      name: "Acme site",
      status: "live",
    })
    .returning({ id: sites.id });
  siteId = siteRows[0]!.id;
});

afterAll(async () => {
  await close();
});

describe("selecting library images", () => {
  it("accepts ready images the client owns", async () => {
    const a = await makeReadyAsset(acme, "one.jpg");
    const b = await makeReadyAsset(acme, "two.jpg");

    const result = await validateAssetSelection(db, acme.ctx, [a, b]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assets.map((x) => x.publicId)).toEqual([a, b]);
  });

  it("refuses an image still being prepared, and says nothing is lost", async () => {
    const pending = await makeReadyAsset(acme, "slow.jpg", { status: "processing" });

    const result = await validateAssetSelection(db, acme.ctx, [pending]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/still being prepared/i);
    // The reassurance matters: this refusal happens on submit, and someone who
    // has just typed three paragraphs needs to know they are safe.
    expect(result.message).toMatch(/nothing you have typed will be lost/i);
  });

  it("refuses another client's image exactly as if it did not exist", async () => {
    const theirs = await makeReadyAsset(globex, "theirs.jpg");

    const result = await validateAssetSelection(db, acme.ctx, [theirs]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Reported as missing, never as forbidden.
    expect(result.message).toMatch(/no longer in your library/i);
  });

  it("keeps the order the client chose", async () => {
    const first = await makeReadyAsset(acme, "first.jpg");
    const second = await makeReadyAsset(acme, "second.jpg");

    const result = await validateAssetSelection(db, acme.ctx, [second, first]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // They will say "the second photo". It has to be the one they meant.
    expect(result.assets.map((x) => x.publicId)).toEqual([second, first]);
  });

  it("refuses more images than one request may carry", async () => {
    const many = [];
    for (let i = 0; i < 25; i += 1) many.push(await makeReadyAsset(acme, `bulk-${i}.jpg`));

    const result = await validateAssetSelection(db, acme.ctx, many);
    expect(result.ok).toBe(false);
  });
});

describe("attaching", () => {
  it("links images and records them as in use", async () => {
    const asset = await makeReadyAsset(acme, "linked.jpg");
    const request = await makeRequest(acme, "Use this photo");

    const attached = await attachAssetsToRequest(db, acme.ctx, request.id, [asset]);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(attached.attached).toBe(1);

    // Visible as in-use immediately, not only once the change goes live —
    // which is when the client is deciding whether they can delete it.
    const usage = await getAssetUsage(db, acme.ctx, asset);
    expect(usage.length).toBe(1);
    expect(usage[0]!.state).toBe("pending");
  });

  it("attaching the same image twice makes one link, not two", async () => {
    const asset = await makeReadyAsset(acme, "retried.jpg");
    const request = await makeRequest(acme, "Retried attach");

    await attachAssetsToRequest(db, acme.ctx, request.id, [asset]);
    await attachAssetsToRequest(db, acme.ctx, request.id, [asset]);

    const links = await db
      .select({ id: requestAssets.id })
      .from(requestAssets)
      .where(eq(requestAssets.requestId, request.id));
    expect(links.length).toBe(1);
  });
});

describe("dispatch snapshots", () => {
  it("freezes the title, folder and size the agent will be told", async () => {
    const folder = await createFolder(db, acme.ctx, { name: "Winter Series" });
    if (!folder.ok) throw new Error(folder.message);
    const { mediaFolders } = await import("@/db/schema");
    const folderRow = await db
      .select({ id: mediaFolders.id })
      .from(mediaFolders)
      .where(eq(mediaFolders.publicId, folder.publicId));

    const asset = await makeReadyAsset(acme, "painting.jpg", {
      title: "Frost",
      description: "Oil on board, 40x30cm",
      width: 3000,
      height: 2000,
      folderId: folderRow[0]!.id,
    });
    const request = await makeRequest(acme, "Add the new painting");
    await attachAssetsToRequest(db, acme.ctx, request.id, [asset]);

    const frozen = await snapshotRequestAssets(db, request.id);
    expect(frozen).toBe(1);

    // Now the client tidies up: renames the piece and refiles it.
    const { mediaAssets: assetsTable } = await import("@/db/schema");
    await db
      .update(assetsTable)
      .set({ title: "Frost (sold)", folderId: null })
      .where(eq(assetsTable.publicId, asset));

    const view = await listRequestAssets(db, acme.ctx, request.publicId);
    expect(view.length).toBe(1);
    // The job keeps the inputs it was dispatched with. Tidying a library must
    // not silently change what someone was asked to build.
    expect(view[0]!.title).toBe("Frost");
    expect(view[0]!.folderPath).toBe("/winter series");
    expect(view[0]!.snapshotted).toBe(true);
  });

  it("does not re-freeze on a second dispatch", async () => {
    const asset = await makeReadyAsset(acme, "stable.jpg", { title: "Original" });
    const request = await makeRequest(acme, "Redispatch me");
    await attachAssetsToRequest(db, acme.ctx, request.id, [asset]);
    await snapshotRequestAssets(db, request.id);

    const { mediaAssets: assetsTable } = await import("@/db/schema");
    await db
      .update(assetsTable)
      .set({ title: "Changed" })
      .where(eq(assetsTable.publicId, asset));

    // A re-dispatch after "ask for changes" must answer the same question the
    // first run was given.
    const refrozen = await snapshotRequestAssets(db, request.id);
    expect(refrozen).toBe(0);

    const view = await listRequestAssets(db, acme.ctx, request.publicId);
    expect(view[0]!.title).toBe("Original");
  });

  it("falls back to the filename so an untitled photo is still referable", async () => {
    const asset = await makeReadyAsset(acme, "DSC_0182.jpg");
    const request = await makeRequest(acme, "Untitled photo");
    await attachAssetsToRequest(db, acme.ctx, request.id, [asset]);
    await snapshotRequestAssets(db, request.id);

    const view = await listRequestAssets(db, acme.ctx, request.publicId);
    expect(view[0]!.title).toBe("DSC_0182.jpg");
  });

  it("reports display dimensions for a rotated photo", async () => {
    const publicId = newPublicId();
    await db.insert(mediaAssets).values({
      publicId,
      organizationId: acme.organizationId,
      status: "ready",
      storageKey: `a/${publicId}/original.jpg`,
      originalFilename: "portrait.jpg",
      contentType: "image/jpeg",
      byteSize: 1024,
      checksumSha256: "c".repeat(64),
      width: 4032,
      height: 3024,
      orientation: 6,
    });

    const request = await makeRequest(acme, "Rotated");
    await attachAssetsToRequest(db, acme.ctx, request.id, [publicId]);
    await snapshotRequestAssets(db, request.id);

    const view = await listRequestAssets(db, acme.ctx, request.publicId);
    // The agent decides layout from this. Told 4032x3024 it would treat a
    // portrait photo as a landscape hero.
    expect(view[0]!.width).toBe(3024);
    expect(view[0]!.height).toBe(4032);
  });
});

describe("idempotent submission", () => {
  it("a resubmitted key returns the original request", async () => {
    const key = `idem-${newPublicId()}`;
    const first = await makeRequest(acme, "Only once", key);
    expect(first.duplicate).toBe(false);

    const second = await createChangeRequest(db, acme.ctx, {
      title: "Only once",
      idempotencyKey: key,
    });

    // The second submission finds the first rather than making another.
    expect(second.duplicate).toBe(true);
    expect(second.publicId).toBe(first.publicId);

    const all = await db
      .select({ id: changeRequests.id })
      .from(changeRequests)
      .where(
        and(
          eq(changeRequests.organizationId, acme.organizationId),
          eq(changeRequests.idempotencyKey, key),
        ),
      );
    expect(all.length).toBe(1);
  });

  it("keys are scoped per client, so one tenant cannot claim another's", async () => {
    const key = "shared-key-value";
    await makeRequest(acme, "Acme's", key);
    const theirs = await makeRequest(globex, "Globex's", key);

    // A globally unique index would have let Acme deny Globex this key.
    expect(theirs.duplicate).toBe(false);

    const found = await findRequestByIdempotencyKey(db, globex.ctx, key);
    expect(found?.title).toBe("Globex's");
  });

  it("requests without a key are unaffected", async () => {
    const a = await makeRequest(acme, "No key one");
    const b = await makeRequest(acme, "No key two");
    expect(a.publicId).not.toBe(b.publicId);
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(false);
  });
});

describe("allowance accounting", () => {
  async function givePlan(tenant: SeededTenant, included: number) {
    const planRows = await db
      .insert(servicePlans)
      .values({
        key: `plan-${newPublicId().slice(0, 8).toLowerCase()}`,
        name: "Test plan",
        defaultMonthlyCents: 9900,
        includedChangesPerMonth: included,
        overagePerChangeCents: 3900,
      })
      .returning({ id: servicePlans.id });

    const { clients } = await import("@/db/schema");
    const clientRow = await db
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.organizationId, tenant.organizationId));

    await db.insert(subscriptions).values({
      publicId: newPublicId(),
      clientId: clientRow[0]!.id,
      planId: planRows[0]!.id,
      status: "active",
      monthlyPriceCents: 9900,
      // A `date` column, not a timestamp — the subscription starts on a day.
      startedOn: new Date().toISOString().slice(0, 10),
    });
  }

  it("a refund puts a spent change back", async () => {
    const tenant = await seedTenant(db, "Refunder");
    await givePlan(tenant, 3);

    const first = await consumeChange(db, tenant.ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.remaining).toBe(2);

    await refundChange(db, first.allowanceId);

    const rows = await db
      .select({ used: changeAllowances.used })
      .from(changeAllowances)
      .where(eq(changeAllowances.id, first.allowanceId));
    // Charging for a change that does not exist is a billing error the client
    // notices and we do not.
    expect(rows[0]!.used).toBe(0);
  });

  it("refuses once the month's allowance is spent", async () => {
    const tenant = await seedTenant(db, "Frugal");
    await givePlan(tenant, 1);

    expect((await consumeChange(db, tenant.ctx)).ok).toBe(true);
    const second = await consumeChange(db, tenant.ctx);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe("exhausted");
  });

  it("a duplicate submission does not spend a second change", async () => {
    const tenant = await seedTenant(db, "DoubleTapper");
    await givePlan(tenant, 3);
    const key = `double-${newPublicId()}`;

    // Two submissions carrying one key, each claiming a change the way the
    // action does before it discovers the duplicate.
    const claimA = await consumeChange(db, tenant.ctx);
    const first = await createChangeRequest(db, tenant.ctx, {
      title: "Tapped twice",
      idempotencyKey: key,
      allowanceId: claimA.ok ? claimA.allowanceId : undefined,
    });
    expect(first.duplicate).toBe(false);

    const claimB = await consumeChange(db, tenant.ctx);
    const second = await createChangeRequest(db, tenant.ctx, {
      title: "Tapped twice",
      idempotencyKey: key,
      allowanceId: claimB.ok ? claimB.allowanceId : undefined,
    });
    expect(second.duplicate).toBe(true);
    // The action hands the second claim straight back on discovering this.
    if (claimB.ok) await refundChange(db, claimB.allowanceId);

    const rows = await db
      .select({ used: changeAllowances.used })
      .from(changeAllowances)
      .where(eq(changeAllowances.id, claimA.ok ? claimA.allowanceId : ""));
    expect(rows[0]!.used).toBe(1);
  });
});

describe("protecting images a request depends on", () => {
  it("refuses to trash an image an open request is using, and names it", async () => {
    const asset = await makeReadyAsset(acme, "in-use.jpg", { title: "Hero shot" });
    const request = await makeRequest(acme, "Put this on the home page");
    await attachAssetsToRequest(db, acme.ctx, request.id, [asset]);

    const result = await trashAssets(db, acme.ctx, [asset]);
    expect(result.ok).toBe(false);
    expect(result.blocked).toContain(asset);
    // Naming the request is the difference between a refusal someone can act
    // on and one that just looks like a bug.
    expect(result.message).toMatch(/Hero shot/);
    expect(result.message).toMatch(/Put this on the home page/);
  });

  it("allows trashing once the request is closed", async () => {
    const asset = await makeReadyAsset(acme, "freed.jpg");
    const request = await makeRequest(acme, "Finished change");
    await attachAssetsToRequest(db, acme.ctx, request.id, [asset]);

    await db
      .update(changeRequests)
      .set({ status: "closed" })
      .where(eq(changeRequests.id, request.id));

    const result = await trashAssets(db, acme.ctx, [asset]);
    expect(result.ok).toBe(true);
  });

  it("trashes the free ones and keeps the blocked one", async () => {
    const blocked = await makeReadyAsset(acme, "blocked.jpg");
    const free = await makeReadyAsset(acme, "free.jpg");
    const request = await makeRequest(acme, "Uses one of them");
    await attachAssetsToRequest(db, acme.ctx, request.id, [blocked]);

    const result = await trashAssets(db, acme.ctx, [blocked, free]);
    // A partial success beats refusing the whole selection.
    expect(result.ok).toBe(true);
    expect(result.blocked).toEqual([blocked]);
    expect(result.message).toMatch(/kept/i);
  });
});

describe("usage", () => {
  it("moves to published when the change goes live", async () => {
    const asset = await makeReadyAsset(acme, "published.jpg");
    const request = await makeRequest(acme, "Ship it");
    await attachAssetsToRequest(db, acme.ctx, request.id, [asset]);

    await markUsagePublished(db, request.id, siteId, "Home page");

    const usage = await getAssetUsage(db, acme.ctx, asset);
    expect(usage[0]!.state).toBe("published");
    expect(usage[0]!.location).toBe("Home page");
  });

  it("releases the claim when a request is cancelled", async () => {
    const asset = await makeReadyAsset(acme, "cancelled.jpg");
    const request = await makeRequest(acme, "Never mind");
    await attachAssetsToRequest(db, acme.ctx, request.id, [asset]);

    await releaseUsage(db, request.id);

    const rows = await db
      .select({ state: mediaUsages.state })
      .from(mediaUsages)
      .where(eq(mediaUsages.requestId, request.id));
    // Otherwise the client is told an image is spoken for by a change that
    // will never happen, and the delete path goes on refusing it.
    expect(rows[0]!.state).toBe("removed");
  });

  it("does not show one client another client's usage", async () => {
    const asset = await makeReadyAsset(globex, "globex-usage.jpg");
    const request = await makeRequest(globex, "Their change");
    await attachAssetsToRequest(db, globex.ctx, request.id, [asset]);

    const seen = await getAssetUsage(db, acme.ctx, asset);
    expect(seen.length).toBe(0);
  });
});
