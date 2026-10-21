import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  agentJobs,
  businessProfiles,
  changeAllowances,
  changeRequests,
  clients,
  mediaAssets,
  mediaDerivatives,
  mediaUsages,
  requestAssets,
  showcases,
  sites,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { currentPeriod } from "@/lib/billing/period";
import { tenantContextFrom, type TenantContext } from "@/db/repositories/context";
import { createChangeRequest } from "@/db/repositories/client/change-requests";
import {
  approveShowcase,
  createShowcase,
  deleteShowcase,
  getShowcase,
  listShowcases,
  loadGraphicSources,
  markPostedToGoogle,
  saveShowcaseWording,
  sendShowcaseToSite,
} from "@/db/repositories/client/showcases";
import type { GooglePostPublisher } from "@/lib/showcase/google-post";
import { listAllShowcases } from "@/db/repositories/admin/showcases";
import type { AdminContext } from "@/db/repositories/context";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * Job showcase, from the client's side.
 *
 * The site page is the part that can go wrong expensively: it is a real change
 * to a real website, so it must obey every rule an ordinary request obeys —
 * one change at a time, the month's allowance, nothing before the first
 * payment — and approving twice must not open two. Each has a test here.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let globex: SeededTenant;
let acmeSitePublicId: string;
let acmeSiteId: string;

const stored = new Map<string, Uint8Array>();

vi.mock("@/lib/storage/driver", () => ({
  mediaDriver: () => ({
    get: async (key: string) => {
      const bytes = stored.get(key);
      return bytes ? { bytes, contentType: "application/octet-stream" } : null;
    },
  }),
}));

vi.mock("@/lib/scheduler/nudge", () => ({ nudgeScheduler: vi.fn() }));

async function readyAsset(tenant: SeededTenant, name: string, status: "ready" | "processing" = "ready") {
  const publicId = newPublicId();
  const storageKey = `a/${publicId}/original.jpg`;
  const [row] = await db
    .insert(mediaAssets)
    .values({
      publicId,
      organizationId: tenant.organizationId,
      status,
      storageKey,
      originalFilename: name,
      contentType: "image/jpeg",
      byteSize: 2048,
      checksumSha256: "c".repeat(64),
      width: 1600,
      height: 1200,
      orientation: 1,
    })
    .returning({ id: mediaAssets.id });
  stored.set(storageKey, new TextEncoder().encode(`original:${name}`));
  return { publicId, id: row!.id, storageKey };
}

async function unlock(tenant: SeededTenant) {
  await db
    .update(clients)
    .set({ changeRequestsUnlockedAt: new Date() })
    .where(eq(clients.organizationId, tenant.organizationId));
}

async function newShowcase(tenant: SeededTenant, overrides: Partial<Parameters<typeof createShowcase>[2]> = {}) {
  const photo = await readyAsset(tenant, "after.jpg");
  const result = await createShowcase(db, tenant.ctx, {
    job: "Replaced a 20-year-old furnace",
    town: "Riverton",
    photoPublicIds: [photo.publicId],
    ...overrides,
  });
  if (!result.ok) throw new Error(result.message);
  return result.publicId;
}

const approvedWording = {
  title: "Replaced a furnace in Riverton",
  writeUp: "We replaced a 20-year-old furnace in Riverton.\n\nNeed something similar? Call 555-0100.",
  caption: "We replaced a 20-year-old furnace in Riverton. Need something similar? Call 555-0100.",
};

async function closeOpenRequests(organizationId: string) {
  await db.update(changeRequests).set({ status: "closed" }).where(eq(changeRequests.organizationId, organizationId));
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  acme = await seedTenant(db, "Acme Heating");
  globex = await seedTenant(db, "Globex Plumbing");

  acmeSitePublicId = newPublicId();
  const [site] = await db
    .insert(sites)
    .values({ publicId: acmeSitePublicId, organizationId: acme.organizationId, name: "Acme Heating", status: "live" })
    .returning({ id: sites.id });
  acmeSiteId = site!.id;

  await db.insert(businessProfiles).values({
    organizationId: acme.organizationId,
    details: {
      businessName: "Acme Heating & Air",
      phone: "555-0100",
      brand: "Navy #1f3a5f, orange #f28c28",
      founded: "1998",
      credentials: "Licensed and insured",
    },
  });
  await unlock(acme);
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await closeOpenRequests(acme.organizationId);
});

describe("createShowcase", () => {
  it("drafts the wording from the client's words and General information", async () => {
    const publicId = await newShowcase(acme, { notes: "the old one was original to the house" });
    const showcase = await getShowcase(db, acme.ctx, publicId);

    expect(showcase.status).toBe("draft");
    expect(showcase.title).toBe("Replaced a 20-year-old furnace in Riverton");
    expect(showcase.writeUp).toContain("We replaced a 20-year-old furnace in Riverton.");
    expect(showcase.writeUp).toContain("The old one was original to the house.");
    expect(showcase.writeUp).toContain("555-0100");
    expect(showcase.writeUp).not.toMatch(/1998|Licensed/);
    expect(showcase.businessName).toBe("Acme Heating & Air");
    expect(showcase.brand.primary).toBe("#1f3a5f");
  });

  it("puts the page on the client's only site without asking", async () => {
    const showcase = await getShowcase(db, acme.ctx, await newShowcase(acme));
    expect(showcase.siteName).toBe("Acme Heating");
  });

  it("keeps the photos in the order chosen, with the before and after marked", async () => {
    const before = await readyAsset(acme, "before.jpg");
    const after = await readyAsset(acme, "after.jpg");
    const detail = await readyAsset(acme, "detail.jpg");
    const result = await createShowcase(db, acme.ctx, {
      job: "New patio",
      town: "Herriman",
      photoPublicIds: [detail.publicId, before.publicId, after.publicId],
      beforePublicId: before.publicId,
      afterPublicId: after.publicId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const showcase = await getShowcase(db, acme.ctx, result.publicId);
    expect(showcase.photos.map((p) => [p.assetPublicId, p.role])).toEqual([
      [detail.publicId, "photo"],
      [before.publicId, "before"],
      [after.publicId, "after"],
    ]);
  });

  it("needs at least one photo", async () => {
    const result = await createShowcase(db, acme.ctx, { job: "New patio", town: "Herriman", photoPublicIds: [] });
    expect(result).toEqual({ ok: false, message: "Choose at least one photo of the job." });
  });

  it("refuses another client's photo exactly like a missing one", async () => {
    const theirs = await readyAsset(globex, "theirs.jpg");
    const result = await createShowcase(db, acme.ctx, {
      job: "New patio",
      town: "Herriman",
      photoPublicIds: [theirs.publicId],
    });
    expect(result.ok).toBe(false);
    expect(await db.select().from(showcases).where(eq(showcases.organizationId, globex.organizationId))).toHaveLength(0);
  });

  it("refuses a photo that is still being prepared", async () => {
    const pending = await readyAsset(acme, "pending.jpg", "processing");
    const result = await createShowcase(db, acme.ctx, {
      job: "New patio",
      town: "Herriman",
      photoPublicIds: [pending.publicId],
    });
    expect(result.ok).toBe(false);
  });

  it("needs a before and an after together, both from the chosen photos", async () => {
    const one = await readyAsset(acme, "one.jpg");
    const two = await readyAsset(acme, "two.jpg");
    const onlyBefore = await createShowcase(db, acme.ctx, {
      job: "New patio",
      town: "Herriman",
      photoPublicIds: [one.publicId, two.publicId],
      beforePublicId: one.publicId,
    });
    expect(onlyBefore).toEqual({ ok: false, message: "Pick both a before and an after photo, or neither." });

    const same = await createShowcase(db, acme.ctx, {
      job: "New patio",
      town: "Herriman",
      photoPublicIds: [one.publicId, two.publicId],
      beforePublicId: one.publicId,
      afterPublicId: one.publicId,
    });
    expect(same.ok).toBe(false);
  });

  it("refuses while an operator is viewing as the client", async () => {
    const viewing: TenantContext = tenantContextFrom(
      { userId: acme.userId, organizationId: acme.organizationId, role: "admin", status: "active", sessionEpoch: 0 },
      acme.organizationId,
      { impersonating: true },
    );
    const photo = await readyAsset(acme, "x.jpg");
    await expect(
      createShowcase(db, viewing, { job: "New patio", town: "Herriman", photoPublicIds: [photo.publicId] }),
    ).rejects.toThrow(/read-only/);
  });
});

describe("listShowcases", () => {
  it("shows a client only their own", async () => {
    await newShowcase(acme);
    expect(await listShowcases(db, globex.ctx)).toEqual([]);
    expect((await listShowcases(db, acme.ctx)).length).toBeGreaterThan(0);
  });

  it("does not open another client's showcase", async () => {
    const publicId = await newShowcase(acme);
    await expect(getShowcase(db, globex.ctx, publicId)).rejects.toThrow();
  });
});

describe("saveShowcaseWording", () => {
  it("saves edits while it is a draft", async () => {
    const publicId = await newShowcase(acme);
    const saved = await saveShowcaseWording(db, acme.ctx, publicId, { ...approvedWording, title: "A better title" });
    expect(saved.ok).toBe(true);
    expect((await getShowcase(db, acme.ctx, publicId)).title).toBe("A better title");
  });

  it("refuses edits once approved, so the page and the posts stay what was approved", async () => {
    const publicId = await newShowcase(acme);
    await approveShowcase(db, acme.ctx, publicId, approvedWording);
    const saved = await saveShowcaseWording(db, acme.ctx, publicId, approvedWording);
    expect(saved.ok).toBe(false);
  });
});

describe("approveShowcase", () => {
  it("opens one change request for the site page, with the photos attached in order", async () => {
    const before = await readyAsset(acme, "before.jpg");
    const after = await readyAsset(acme, "after.jpg");
    const created = await createShowcase(db, acme.ctx, {
      job: "Replaced a furnace",
      town: "Riverton",
      photoPublicIds: [before.publicId, after.publicId],
      beforePublicId: before.publicId,
      afterPublicId: after.publicId,
    });
    if (!created.ok) throw new Error(created.message);

    const result = await approveShowcase(db, acme.ctx, created.publicId, approvedWording);
    expect(result.ok).toBe(true);

    const showcase = await getShowcase(db, acme.ctx, created.publicId);
    expect(showcase.status).toBe("approved");
    expect(showcase.site.label).toBe("Waiting");
    expect(showcase.requestPublicId).not.toBeNull();

    const [request] = await db
      .select()
      .from(changeRequests)
      .where(eq(changeRequests.publicId, showcase.requestPublicId!));
    expect(request!.title).toBe("Add a project: Replaced a furnace in Riverton");
    expect(request!.status).toBe("submitted");
    expect(request!.siteId).toBe(acmeSiteId);
    expect(request!.category).toBe("content");
    expect(request!.description).toContain("We replaced a 20-year-old furnace in Riverton.");
    expect(request!.description).toContain("Photo 1 is before and photo 2 is after");

    const linked = await db
      .select({ assetId: requestAssets.assetId, position: requestAssets.position })
      .from(requestAssets)
      .where(eq(requestAssets.requestId, request!.id))
      .orderBy(requestAssets.position);
    expect(linked.map((l) => l.assetId)).toEqual([before.id, after.id]);

    // Spoken for, so the library will not let them be deleted mid-change.
    const usage = await db.select().from(mediaUsages).where(eq(mediaUsages.requestId, request!.id));
    expect(usage).toHaveLength(2);
  });

  it("counts the page as one of the month's changes", async () => {
    const [{ used: before = 0 } = {}] = await db
      .select({ used: changeAllowances.used })
      .from(changeAllowances)
      .where(eq(changeAllowances.clientId, acme.clientId));
    await approveShowcase(db, acme.ctx, await newShowcase(acme), approvedWording);
    const [{ used: after = 0 } = {}] = await db
      .select({ used: changeAllowances.used })
      .from(changeAllowances)
      .where(eq(changeAllowances.clientId, acme.clientId));
    expect(after).toBe(before + 1);
  });

  it("does not open a second request when approved twice", async () => {
    const publicId = await newShowcase(acme);
    await approveShowcase(db, acme.ctx, publicId, approvedWording);
    const again = await approveShowcase(db, acme.ctx, publicId, approvedWording);
    expect(again.ok).toBe(false);

    const sent = await sendShowcaseToSite(db, acme.ctx, publicId);
    expect(sent.ok).toBe(false);
    const requests = await db
      .select()
      .from(changeRequests)
      .where(and(eq(changeRequests.organizationId, acme.organizationId), eq(changeRequests.status, "submitted")));
    expect(requests).toHaveLength(1);
  });

  it("waits, and spends nothing, while another change is open on the site", async () => {
    await createChangeRequest(db, acme.ctx, { title: "Change the hours", sitePublicId: acmeSitePublicId });
    const [{ used: before = 0 } = {}] = await db
      .select({ used: changeAllowances.used })
      .from(changeAllowances)
      .where(eq(changeAllowances.clientId, acme.clientId));

    const publicId = await newShowcase(acme);
    const result = await approveShowcase(db, acme.ctx, publicId, approvedWording);
    expect(result.ok).toBe(true);

    const showcase = await getShowcase(db, acme.ctx, publicId);
    expect(showcase.status).toBe("approved");
    expect(showcase.site.state).toBe("blocked");
    expect(showcase.site.detail).toMatch(/another change/i);
    expect(showcase.requestPublicId).toBeNull();

    const [{ used: after = 0 } = {}] = await db
      .select({ used: changeAllowances.used })
      .from(changeAllowances)
      .where(eq(changeAllowances.clientId, acme.clientId));
    expect(after).toBe(before);

    // Once that change is done, sending again works.
    await closeOpenRequests(acme.organizationId);
    const sent = await sendShowcaseToSite(db, acme.ctx, publicId);
    expect(sent.ok).toBe(true);
    expect((await getShowcase(db, acme.ctx, publicId)).site.state).toBe("waiting");
  });

  it("waits when the month's changes are used up", async () => {
    const tenant = await seedTenant(db, "Lite Landscaping");
    await unlock(tenant);
    await db.insert(sites).values({ publicId: newPublicId(), organizationId: tenant.organizationId, name: "Lite" });
    const period = currentPeriod();
    await db.insert(changeAllowances).values({
      clientId: tenant.clientId,
      periodStart: period.start,
      periodEnd: period.end,
      included: 1,
      used: 1,
    });

    const publicId = await newShowcase(tenant);
    await approveShowcase(db, tenant.ctx, publicId, approvedWording);
    const showcase = await getShowcase(db, tenant.ctx, publicId);
    expect(showcase.site.state).toBe("blocked");
    expect(showcase.site.detail).toMatch(/used this month/i);
  });

  it("waits before the first payment, and when there is no site", async () => {
    const locked = await seedTenant(db, "Locked Lawns");
    await db.insert(sites).values({ publicId: newPublicId(), organizationId: locked.organizationId, name: "Locked" });
    const lockedId = await newShowcase(locked);
    await approveShowcase(db, locked.ctx, lockedId, approvedWording);
    expect((await getShowcase(db, locked.ctx, lockedId)).site.detail).toMatch(/first payment/);

    const siteless = await seedTenant(db, "No Site Yet");
    await unlock(siteless);
    const sitelessId = await newShowcase(siteless);
    await approveShowcase(db, siteless.ctx, sitelessId, approvedWording);
    expect((await getShowcase(db, siteless.ctx, sitelessId)).site.detail).toMatch(/nowhere to put the page/);
  });

  it("marks the Google post for posting by hand when there is no connection", async () => {
    const publicId = await newShowcase(acme);
    await approveShowcase(db, acme.ctx, publicId, approvedWording);
    const showcase = await getShowcase(db, acme.ctx, publicId);
    expect(showcase.google.label).toBe("Post manually");
    expect(showcase.googlePost.summary).toBe(approvedWording.writeUp);
    expect(showcase.googlePost.cta).toEqual({ actionType: "CALL" });

    await markPostedToGoogle(db, acme.ctx, publicId);
    expect((await getShowcase(db, acme.ctx, publicId)).google.label).toBe("Posted");
  });

  it("posts to Google through a connected publisher, and records a failure plainly", async () => {
    const posted: unknown[] = [];
    const connected: GooglePostPublisher = {
      isConnected: async () => true,
      publish: async (_db, organizationId, post) => {
        posted.push({ organizationId, post });
        return { ok: true, postName: "accounts/1/locations/2/localPosts/3" };
      },
    };
    const publicId = await newShowcase(acme);
    await approveShowcase(db, acme.ctx, publicId, approvedWording, { publisher: connected });
    expect(posted).toHaveLength(1);
    expect((await getShowcase(db, acme.ctx, publicId)).google.label).toBe("Posted");

    const failing: GooglePostPublisher = {
      isConnected: async () => true,
      publish: async () => ({ ok: false, message: "Quota exceeded" }),
    };
    await closeOpenRequests(acme.organizationId);
    const second = await newShowcase(acme);
    await approveShowcase(db, acme.ctx, second, approvedWording, { publisher: failing });
    const showcase = await getShowcase(db, acme.ctx, second);
    expect(showcase.google.label).toBe("Didn't post");
    expect(showcase.googleError).toBe("Quota exceeded");
  });

  it("says preview ready only once the operator has released the preview", async () => {
    const publicId = await newShowcase(acme);
    await approveShowcase(db, acme.ctx, publicId, approvedWording);
    const { requestPublicId } = await getShowcase(db, acme.ctx, publicId);
    const [request] = await db.select().from(changeRequests).where(eq(changeRequests.publicId, requestPublicId!));
    await db.update(changeRequests).set({ status: "pr_open" }).where(eq(changeRequests.id, request!.id));

    // An older job, released, and the newest one not yet: the newest decides.
    await db.insert(agentJobs).values({
      publicId: newPublicId(),
      requestId: request!.id,
      status: "cancelled",
      operatorReleasedAt: new Date(),
      createdAt: new Date(Date.now() - 60_000),
    });
    const [latest] = await db
      .insert(agentJobs)
      .values({ publicId: newPublicId(), requestId: request!.id, status: "pr_open" })
      .returning({ id: agentJobs.id });
    expect((await getShowcase(db, acme.ctx, publicId)).site.label).toBe("Waiting");

    await db
      .update(agentJobs)
      .set({ operatorReleasedAt: new Date(), previewVerifiedAt: new Date() })
      .where(eq(agentJobs.id, latest!.id));
    expect((await getShowcase(db, acme.ctx, publicId)).site.label).toBe("Preview ready");
  });
});

describe("deleteShowcase", () => {
  it("removes the client's own, and nobody else's", async () => {
    const publicId = await newShowcase(acme);
    await expect(deleteShowcase(db, globex.ctx, publicId)).rejects.toThrow();
    await deleteShowcase(db, acme.ctx, publicId);
    await expect(getShowcase(db, acme.ctx, publicId)).rejects.toThrow();
  });
});

describe("listAllShowcases (operator)", () => {
  it("shows every client's showcases with the client named, and a blocked page's reason", async () => {
    const theirs = await newShowcase(globex);
    await createChangeRequest(db, acme.ctx, { title: "Change the hours", sitePublicId: acmeSitePublicId });
    const ours = await newShowcase(acme);
    await approveShowcase(db, acme.ctx, ours, approvedWording);

    const rows = await listAllShowcases({ userId: acme.userId } as AdminContext, db);
    const byId = new Map(rows.map((r) => [r.publicId, r]));
    expect(byId.get(theirs)?.organizationName).toBe("Globex Plumbing");
    expect(byId.get(theirs)?.status).toBe("draft");
    expect(byId.get(ours)?.organizationName).toBe("Acme Heating");
    expect(byId.get(ours)?.site.state).toBe("blocked");
    expect(byId.get(ours)?.photoCount).toBe(1);
  });
});

describe("loadGraphicSources", () => {
  it("prefers the large web size to the original, and skips trashed photos", async () => {
    const withWeb = await readyAsset(acme, "web.jpg");
    const webKey = `a/${withWeb.publicId}/web_lg.webp`;
    stored.set(webKey, new TextEncoder().encode("web_lg"));
    await db.insert(mediaDerivatives).values({
      assetId: withWeb.id,
      kind: "web_lg",
      storageKey: webKey,
      contentType: "image/webp",
      width: 2048,
      height: 1536,
      byteSize: 6,
    });
    const plain = await readyAsset(acme, "plain.jpg");
    const trashed = await readyAsset(acme, "trashed.jpg");

    const created = await createShowcase(db, acme.ctx, {
      job: "New patio",
      town: "Herriman",
      photoPublicIds: [trashed.publicId, withWeb.publicId, plain.publicId],
    });
    if (!created.ok) throw new Error(created.message);
    await db.update(mediaAssets).set({ deletedAt: new Date() }).where(eq(mediaAssets.id, trashed.id));

    const sources = await loadGraphicSources(db, acme.ctx, created.publicId);
    expect(sources.photos.map((p) => new TextDecoder().decode(p))).toEqual(["web_lg"]);
    expect(sources.pair).toBe(false);
    expect(sources.businessName).toBe("Acme Heating & Air");
  });

  it("uses the before and after as a pair when both are there", async () => {
    const before = await readyAsset(acme, "b.jpg");
    const after = await readyAsset(acme, "a.jpg");
    const created = await createShowcase(db, acme.ctx, {
      job: "New patio",
      town: "Herriman",
      photoPublicIds: [after.publicId, before.publicId],
      beforePublicId: before.publicId,
      afterPublicId: after.publicId,
    });
    if (!created.ok) throw new Error(created.message);

    const sources = await loadGraphicSources(db, acme.ctx, created.publicId);
    expect(sources.pair).toBe(true);
    expect(sources.photos.map((p) => new TextDecoder().decode(p))).toEqual(["original:b.jpg", "original:a.jpg"]);
  });
});
