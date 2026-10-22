import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  clientAddOns,
  googleConnections,
  googleLocations,
  googleProfileChanges,
  googleReviews,
  mediaAssets,
  users,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { adminContextFrom, tenantContextFrom, type AdminContext } from "@/db/repositories/context";
import {
  completeGoogleConnect,
  disconnectGoogle,
  getGoogleConnectionStatus,
  resetGoogleTokenCache,
} from "@/db/repositories/admin/google-connection";
import { backoffFor, runScheduledGoogleSync } from "@/db/repositories/admin/google-sync";
import {
  addGooglePhoto,
  linkGoogleLocation,
  postReviewReply,
  publishGooglePost,
  resolveGoogleRequest,
  saveReplyDraft,
  updateGoogleDescription,
  updateGoogleHours,
  updateGoogleSpecialHours,
} from "@/db/repositories/admin/google-edits";
import { getGoogleQueue, getGoogleWorkspace, listLinkableLocations } from "@/db/repositories/admin/google-profile";
import {
  askForGoogleChange,
  getGoogleProfileView,
  getGoogleReviewLink,
  getGoogleReviewStats,
} from "@/db/repositories/client/google-profile";
import { emptyWeek } from "@/lib/google-business/normalize";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";
import { fakeGoogle, QUOTA_ERROR, sampleLocation, type FakeGoogle } from "./helpers/google-fake";

/**
 * Google profile management, end to end against a fake Google at the HTTP
 * boundary and the real migrations on PGlite.
 *
 * The failures worth a test are the quiet ones: a project with no API access
 * shown as connected, a 429 that lets the sync keep spending quota, a draft
 * reply that posts itself, one client's profile or asks reaching another.
 */

let db: Database;
let close: () => Promise<void>;
let admin: AdminContext;
let acme: SeededTenant;
let globex: SeededTenant;
let acmeClientPublicId: string;
let google: FakeGoogle;

const ENV = {
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  GOOGLE_TOKEN_KEY: Buffer.alloc(32, 3).toString("base64"),
  AUTH_URL: "https://portal.example",
  AUTH_SECRET: "test-secret-that-is-long-enough-for-hmac",
};
const savedEnv: Record<string, string | undefined> = {};

async function clientPublicIdOf(tenant: SeededTenant): Promise<string> {
  const rows = await db.execute(sql`select public_id from clients where id = ${tenant.clientId}`);
  return (rows.rows[0] as { public_id: string }).public_id;
}

async function grantFeature(tenant: SeededTenant) {
  await db.insert(clientAddOns).values({ clientId: tenant.clientId, featureKey: "google-profile", source: "operator" });
}

async function connect() {
  return completeGoogleConnect(admin, db, { code: "code", codeVerifier: "verifier" });
}

function seedAcmeOnGoogle(g: FakeGoogle) {
  g.addLocation(sampleLocation("456"));
  g.state.averageRating.set("locations/456", 4.5);
  g.addReview("locations/456", {
    reviewId: "rev-happy",
    reviewer: { displayName: "Dana Smith" },
    starRating: "FIVE",
    comment: "Fixed our water heater the same day.",
    createTime: "2026-10-10T15:00:00Z",
  });
  g.addReview("locations/456", {
    reviewId: "rev-unhappy",
    reviewer: { displayName: "A Google User", isAnonymous: true },
    starRating: "ONE",
    comment: "Nobody called me back.",
    createTime: "2026-10-12T15:00:00Z",
  });
  g.addReview("locations/456", {
    reviewId: "rev-answered",
    reviewer: { displayName: "Lee Park" },
    starRating: "FOUR",
    createTime: "2026-09-01T15:00:00Z",
    reviewReply: { comment: "Thanks, Lee!", updateTime: "2026-09-02T15:00:00Z" },
  });
  g.setMetric("locations/456", "2026-10-15", "CALL_CLICKS", 4);
  g.setMetric("locations/456", "2026-10-15", "BUSINESS_IMPRESSIONS_MOBILE_MAPS", 90);
  g.setMetric("locations/456", "2026-10-16", "WEBSITE_CLICKS", 6);
  g.setMetric("locations/456", "2026-10-16", "BUSINESS_DIRECTION_REQUESTS", 2);
  g.setKeywords("locations/456", "2026-09", [
    { keyword: "plumber riverton", value: 140 },
    { keyword: "water heater repair", threshold: 15 },
  ]);
}

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;

  const [adminUser] = await db
    .insert(users)
    .values({ publicId: newPublicId(), email: "operator@example.test", name: "Scott", role: "admin", status: "active" })
    .returning({ id: users.id });
  admin = adminContextFrom({ userId: adminUser!.id, organizationId: null, role: "admin", status: "active", sessionEpoch: 0 });

  acme = await seedTenant(db, "Acme Plumbing");
  globex = await seedTenant(db, "Globex Roofing");
  await grantFeature(acme);
  acmeClientPublicId = await clientPublicIdOf(acme);

  for (const [key, value] of Object.entries(ENV)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
});

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await close();
});

beforeEach(async () => {
  google = fakeGoogle();
  vi.stubGlobal("fetch", google.fetch);
  resetGoogleTokenCache();
  await db.delete(googleLocations);
  await db.delete(googleConnections);
  await db.execute(sql`delete from google_profile_requests`);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the connection", () => {
  it("is not configured without the environment, and names what is missing", async () => {
    const saved = process.env.GOOGLE_TOKEN_KEY;
    delete process.env.GOOGLE_TOKEN_KEY;
    try {
      expect(await getGoogleConnectionStatus(db)).toMatchObject({ state: "not_configured", missing: ["GOOGLE_TOKEN_KEY"] });
      expect(await runScheduledGoogleSync(db)).toEqual({ ran: false, reason: "not_configured" });
      expect(google.calls).toHaveLength(0);
    } finally {
      process.env.GOOGLE_TOKEN_KEY = saved;
    }
  });

  it("connects, seals the refresh token, and is connected when Google answers", async () => {
    expect(await getGoogleConnectionStatus(db)).toMatchObject({ state: "not_connected" });

    const result = await connect();
    expect(result).toMatchObject({ ok: true, email: "agency@example.test" });
    expect(await getGoogleConnectionStatus(db)).toMatchObject({ state: "connected", email: "agency@example.test" });

    const [row] = await db.select().from(googleConnections);
    expect(row!.refreshTokenSealed.startsWith("v1.")).toBe(true);
    expect(row!.refreshTokenSealed).not.toContain("refresh-1");
    expect(row!.lastSuccessAt).not.toBeNull();
  });

  it("calls a project with no API access what it is — not connected, not 'connected'", async () => {
    // An unapproved project: sign-in works, every API call is refused for quota.
    google.failWhen((c) => c.url.host.startsWith("mybusiness"), 429, QUOTA_ERROR, { times: 100 });

    await connect();
    expect(await getGoogleConnectionStatus(db)).toMatchObject({ state: "no_access", reason: "quota" });

    // The day Google approves, the next probe finds it without anyone reconnecting.
    google = fakeGoogle();
    vi.stubGlobal("fetch", google.fetch);
    await db.update(googleConnections).set({ lastErrorAt: new Date(Date.now() - 7 * 60 * 60 * 1000), quotaPausedUntil: null });
    const run = await runScheduledGoogleSync(db);
    expect(run).toMatchObject({ ran: true, probed: true });
    expect(await getGoogleConnectionStatus(db)).toMatchObject({ state: "connected" });
  });

  it("tells a disabled API apart from missing quota", async () => {
    google.failWhen((c) => c.url.host.startsWith("mybusinessaccountmanagement"), 403, {
      error: { code: 403, message: "My Business Account Management API has not been used in project 1 before or it is disabled.", status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] },
    });
    await connect();
    expect(await getGoogleConnectionStatus(db)).toMatchObject({ state: "no_access", reason: "api_disabled" });
  });

  it("asks for a reconnect when Google revokes the refresh token, and stops syncing", async () => {
    seedAcmeOnGoogle(google);
    await connect();
    await linkGoogleLocation(admin, db, acmeClientPublicId, { accountName: "accounts/111", locationName: "locations/456" });

    // Revoked at Google (or expired: Testing-mode consent screens expire
    // refresh tokens after seven days).
    resetGoogleTokenCache();
    google.state.refreshToken = "something-else";
    await db.update(googleLocations).set({ nextSyncAt: new Date(0) });

    expect(await runScheduledGoogleSync(db)).toMatchObject({ ran: true, synced: 0, stopped: "auth" });
    expect(await getGoogleConnectionStatus(db)).toMatchObject({ state: "needs_reconnect" });
    const [location] = await db.select().from(googleLocations);
    expect(location!.syncFailures).toBe(0);

    const before = google.calls.length;
    expect(await runScheduledGoogleSync(db)).toEqual({ ran: false, reason: "needs_reconnect" });
    expect(google.calls.length).toBe(before);
  });

  it("replaces the previous connection rather than keeping two", async () => {
    await connect();
    google.state.identity = { sub: "google-sub-2", email: "new@example.test" };
    await connect();
    const rows = await db.select().from(googleConnections);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.revokedAt === null).map((r) => r.googleEmail)).toEqual(["new@example.test"]);
  });

  it("revokes at Google on disconnect", async () => {
    await connect();
    await disconnectGoogle(admin, db);
    expect(google.state.revoked).toEqual(["refresh-1"]);
    expect(await getGoogleConnectionStatus(db)).toMatchObject({ state: "not_connected" });
  });
});

describe("linking and syncing a profile", () => {
  beforeEach(async () => {
    seedAcmeOnGoogle(google);
    await connect();
  });

  it("lists what the agency can see, with pending manager invitations", async () => {
    google.state.invitations = [{ name: "accounts/111/invitations/inv1", role: "MANAGER", targetLocation: { locationName: "Initech Electric" } }];
    const linkable = await listLinkableLocations(admin, db);
    expect(linkable.locations).toEqual([
      expect.objectContaining({ name: "locations/456", accountName: "accounts/111", title: "Acme Plumbing", linkedTo: null }),
    ]);
    expect(linkable.invitations).toEqual([{ name: "accounts/111/invitations/inv1", role: "MANAGER", target: "Initech Electric" }]);
  });

  it("links, syncs everything, and drafts — but never posts — replies", async () => {
    const result = await linkGoogleLocation(admin, db, acmeClientPublicId, { accountName: "accounts/111", locationName: "locations/456" });
    expect(result).toMatchObject({ ok: true });

    const reviews = await db.select().from(googleReviews).orderBy(googleReviews.googleReviewId);
    expect(reviews.map((r) => [r.googleReviewId, r.replyComment !== null, r.draftSource])).toEqual([
      ["rev-answered", true, null],
      ["rev-happy", false, "portal"],
      ["rev-unhappy", false, "portal"],
    ]);
    expect(reviews.find((r) => r.googleReviewId === "rev-unhappy")!.draftReply).toContain("(801) 555-0100");
    expect(google.calls.filter((c) => c.method === "PUT")).toHaveLength(0);

    const view = await getGoogleProfileView(db, acme.ctx, { now: new Date("2026-10-20T12:00:00Z") });
    expect(view.state).toBe("linked");
    if (view.state !== "linked") return;
    expect(view.snapshot?.title).toBe("Acme Plumbing");
    expect(view.averageRating).toBe(4.5);
    expect(view.unanswered).toBe(2);
    expect(view.reviews.map((r) => r.replyState)).toEqual(["drafting", "drafting", "replied"]);
    expect(view.metrics).toMatchObject({ state: "ok", totals: { calls: 4, mapsViews: 90, websiteClicks: 6, directionRequests: 2 } });
    expect(view.searches).toMatchObject({ atLeast: 140, hasHidden: true });

    expect(await getGoogleReviewLink(db, acme.ctx)).toEqual({ url: "https://search.google.com/local/writereview?placeid=place-456" });
    expect(await getGoogleReviewStats(db, acme.ctx)).toEqual({
      ok: true,
      stats: { rating: 4.5, reviewCount: 3, source: "Google Business Profile" },
    });
  });

  it("refuses to link a profile already linked to another client", async () => {
    await linkGoogleLocation(admin, db, acmeClientPublicId, { accountName: "accounts/111", locationName: "locations/456" });
    const result = await linkGoogleLocation(admin, db, await clientPublicIdOf(globex), { accountName: "accounts/111", locationName: "locations/456" });
    expect(result).toEqual({ ok: false, message: "That profile is already linked to another client." });
  });

  it("marks a review gone from Google as removed after a complete sync", async () => {
    await linkGoogleLocation(admin, db, acmeClientPublicId, { accountName: "accounts/111", locationName: "locations/456" });
    google.state.reviews.set("locations/456", google.state.reviews.get("locations/456")!.filter((r) => r.reviewId !== "rev-unhappy"));
    await db.update(googleLocations).set({ nextSyncAt: new Date(0) });

    await runScheduledGoogleSync(db);
    const [gone] = await db.select().from(googleReviews).where(eq(googleReviews.googleReviewId, "rev-unhappy"));
    expect(gone!.removedAt).not.toBeNull();
    expect((await getGoogleQueue(admin, db)).unansweredReviews.map((r) => r.reviewerName)).toEqual(["Dana Smith"]);
  });

  it("backs a failing location off, longer each time, without stopping the others", async () => {
    await linkGoogleLocation(admin, db, acmeClientPublicId, { accountName: "accounts/111", locationName: "locations/456" });
    google.failWhen((c) => c.url.pathname.includes("/locations/456"), 403, {
      error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" },
    }, { times: 10 });

    const now = new Date();
    await db.update(googleLocations).set({ nextSyncAt: new Date(0) });
    expect(await runScheduledGoogleSync(db, { now })).toMatchObject({ ran: true, synced: 0, failed: 1 });
    let [row] = await db.select().from(googleLocations);
    expect(row!.syncFailures).toBe(1);
    expect(row!.nextSyncAt!.getTime() - now.getTime()).toBe(backoffFor(1));
    expect(row!.lastSyncError).toMatch(/^permission: .*Manager/);

    await runScheduledGoogleSync(db, { now: new Date(row!.nextSyncAt!.getTime() + 1) });
    [row] = await db.select().from(googleLocations);
    expect(row!.syncFailures).toBe(2);
    expect(backoffFor(2)).toBe(2 * backoffFor(1));
    expect(backoffFor(20)).toBe(24 * 60 * 60 * 1000);

    // A permission problem is this client's, not the connection's.
    expect(await getGoogleConnectionStatus(db)).toMatchObject({ state: "connected" });
  });

  it("stops the whole run on a 429 and pauses every caller", async () => {
    await linkGoogleLocation(admin, db, acmeClientPublicId, { accountName: "accounts/111", locationName: "locations/456" });
    await db.update(googleLocations).set({ nextSyncAt: new Date(0) });
    google.failWhen(() => true, 429, QUOTA_ERROR, { headers: { "retry-after": "120" } });

    expect(await runScheduledGoogleSync(db)).toMatchObject({ ran: true, synced: 0, stopped: "quota" });
    const [row] = await db.select().from(googleLocations);
    expect(row!.syncFailures).toBe(0);

    const before = google.calls.length;
    expect(await runScheduledGoogleSync(db)).toMatchObject({ ran: false, reason: "quota_paused" });
    const edit = await updateGoogleDescription(admin, db, acmeClientPublicId, "Plumbing in Riverton.");
    expect(edit.ok).toBe(false);
    expect(google.calls.length).toBe(before);
    // Worked before, so this is rate limiting, not missing access.
    expect(await getGoogleConnectionStatus(db)).toMatchObject({ state: "connected" });
  });
});

describe("the operator's edits", () => {
  beforeEach(async () => {
    seedAcmeOnGoogle(google);
    await connect();
    await linkGoogleLocation(admin, db, acmeClientPublicId, { accountName: "accounts/111", locationName: "locations/456" });
  });

  it("changes the hours on Google and logs what they were before", async () => {
    const week = { ...emptyWeek(), MONDAY: [{ open: "07:00", close: "15:00" }] };
    const result = await updateGoogleHours(admin, db, acmeClientPublicId, week);
    expect(result).toMatchObject({ ok: true, message: expect.stringContaining("Mon 7 am – 3 pm") });
    expect(google.state.locations.get("locations/456")!.regularHours!.periods).toEqual([
      { openDay: "MONDAY", openTime: { hours: 7, minutes: 0 }, closeDay: "MONDAY", closeTime: { hours: 15, minutes: 0 } },
    ]);

    const [change] = await db.select().from(googleProfileChanges).where(eq(googleProfileChanges.kind, "hours"));
    expect(change!.status).toBe("applied");
    expect((change!.before as Record<string, unknown>).FRIDAY).toEqual([{ open: "08:00", close: "17:00" }]);
    expect(change!.actorUserId).toBe(admin.userId);
  });

  it("logs a refused edit as failed, with Google's reason", async () => {
    google.failWhen((c) => c.method === "PATCH", 400, { error: { code: 400, message: "Request contains an invalid argument.", status: "INVALID_ARGUMENT" } });
    const result = await updateGoogleSpecialHours(admin, db, acmeClientPublicId, [{ date: "2026-11-26", closed: true }]);
    expect(result).toEqual({ ok: false, message: "Google refused the change: Request contains an invalid argument." });
    const [change] = await db.select().from(googleProfileChanges).where(eq(googleProfileChanges.kind, "special_hours"));
    expect(change).toMatchObject({ status: "failed", error: expect.stringContaining("invalid argument") });
  });

  it("refuses a description Google would refuse, before asking Google", async () => {
    const before = google.calls.length;
    expect(await updateGoogleDescription(admin, db, acmeClientPublicId, "See www.acme.example")).toMatchObject({ ok: false });
    expect(await updateGoogleDescription(admin, db, acmeClientPublicId, "x".repeat(751))).toMatchObject({ ok: false });
    expect(google.calls.length).toBe(before);
  });

  it("posts with a photo from the client's own library, as a signed link", async () => {
    const assetId = newPublicId();
    await db.insert(mediaAssets).values({
      publicId: assetId,
      organizationId: acme.organizationId,
      status: "ready",
      storageKey: `media/${assetId}`,
      originalFilename: "new-water-heater.jpg",
      contentType: "image/jpeg",
      byteSize: 1000,
      checksumSha256: "0".repeat(64),
    });
    const otherId = newPublicId();
    await db.insert(mediaAssets).values({
      publicId: otherId,
      organizationId: globex.organizationId,
      status: "ready",
      storageKey: `media/${otherId}`,
      originalFilename: "globex-roof.jpg",
      contentType: "image/jpeg",
      byteSize: 1000,
      checksumSha256: "0".repeat(64),
    });

    expect(
      await publishGooglePost(admin, db, acmeClientPublicId, { summary: "Another client's photo", mediaAssetPublicId: otherId }),
    ).toMatchObject({ ok: false });

    const result = await publishGooglePost(admin, db, acmeClientPublicId, {
      summary: "A new water heater, in and running by lunch.",
      mediaAssetPublicId: assetId,
      cta: { type: "CALL" },
    });
    expect(result).toEqual({ ok: true, message: "Posted to Google." });
    const sent = google.state.posts.get("locations/456")![0]!.body as { media: Array<{ sourceUrl: string }>; callToAction: unknown };
    expect(sent.media[0]!.sourceUrl).toMatch(/^https:\/\/portal\.example\/api\/media\/agent\//);
    expect(sent.callToAction).toEqual({ actionType: "CALL" });

    const [location] = await db.select().from(googleLocations);
    expect(location!.lastPostAt).not.toBeNull();

    expect(await addGooglePhoto(admin, db, acmeClientPublicId, assetId)).toMatchObject({ ok: true });
    expect(google.state.media.get("locations/456")).toHaveLength(1);
  });

  it("posts exactly the reply the operator approved, and only then", async () => {
    const [review] = await db.select().from(googleReviews).where(eq(googleReviews.googleReviewId, "rev-unhappy"));
    await saveReplyDraft(admin, db, acmeClientPublicId, review!.id, "We're sorry. Please call us at (801) 555-0100.");
    expect(google.calls.filter((c) => c.method === "PUT")).toHaveLength(0);

    const result = await postReviewReply(admin, db, acmeClientPublicId, review!.id, "We're sorry. Please call us at (801) 555-0100.");
    expect(result).toEqual({ ok: true, message: "Reply posted on Google." });
    const put = google.calls.find((c) => c.method === "PUT")!;
    expect(put.url.pathname).toBe("/v4/accounts/111/locations/456/reviews/rev-unhappy/reply");
    expect(put.body).toEqual({ comment: "We're sorry. Please call us at (801) 555-0100." });

    const [after] = await db.select().from(googleReviews).where(eq(googleReviews.id, review!.id));
    expect(after).toMatchObject({ replyComment: "We're sorry. Please call us at (801) 555-0100.", draftReply: null });
  });

  it("keeps a failed reply as the operator's draft, with the reason", async () => {
    const [review] = await db.select().from(googleReviews).where(eq(googleReviews.googleReviewId, "rev-happy"));
    google.failWhen((c) => c.method === "PUT", 404, { error: { code: 404, message: "Not found", status: "NOT_FOUND" } });
    const result = await postReviewReply(admin, db, acmeClientPublicId, review!.id, "Thanks, Dana!");
    expect(result.ok).toBe(false);
    const [after] = await db.select().from(googleReviews).where(eq(googleReviews.id, review!.id));
    expect(after).toMatchObject({ replyComment: null, draftReply: "Thanks, Dana!", draftSource: "operator" });
    expect(after!.replyError).toBeTruthy();
  });

  it("does not let a later sync overwrite the operator's edited draft", async () => {
    const [review] = await db.select().from(googleReviews).where(eq(googleReviews.googleReviewId, "rev-happy"));
    await saveReplyDraft(admin, db, acmeClientPublicId, review!.id, "My own words.");
    await db.update(googleLocations).set({ nextSyncAt: new Date(0) });
    await runScheduledGoogleSync(db);
    const [after] = await db.select().from(googleReviews).where(eq(googleReviews.id, review!.id));
    expect(after).toMatchObject({ draftReply: "My own words.", draftSource: "operator" });
  });
});

describe("the client's side", () => {
  it("shows a profile not linked yet, with the address to add as Manager", async () => {
    await connect();
    expect(await getGoogleProfileView(db, acme.ctx)).toMatchObject({ state: "not_linked", agencyEmail: "agency@example.test" });
  });

  it("shows no figures rather than zeros before the first sync of figures", async () => {
    await connect();
    seedAcmeOnGoogle(google);
    google.state.metrics.clear();
    await linkGoogleLocation(admin, db, acmeClientPublicId, { accountName: "accounts/111", locationName: "locations/456" });
    const view = await getGoogleProfileView(db, acme.ctx);
    expect(view.state === "linked" && view.metrics).toEqual({ state: "none" });
  });

  it("puts an ask in the operator's queue and shows it back once resolved", async () => {
    expect(await askForGoogleChange(db, acme.ctx, "We're closed on Thanksgiving.")).toMatchObject({ ok: true });

    const queue = await getGoogleQueue(admin, db);
    expect(queue.asks.map((a) => [a.organizationName, a.body])).toEqual([["Acme Plumbing", "We're closed on Thanksgiving."]]);

    await resolveGoogleRequest(admin, db, queue.asks[0]!.publicId, { status: "done", note: "Set to closed on Nov 26." });
    const view = await getGoogleProfileView(db, acme.ctx);
    expect(view.requests[0]).toMatchObject({ status: "done", operatorNote: "Set to closed on Nov 26." });
  });

  it("keeps each client's profile and asks to themselves", async () => {
    await connect();
    seedAcmeOnGoogle(google);
    await linkGoogleLocation(admin, db, acmeClientPublicId, { accountName: "accounts/111", locationName: "locations/456" });
    await askForGoogleChange(db, acme.ctx, "New phone number please.");

    const theirs = await getGoogleProfileView(db, globex.ctx);
    expect(theirs).toMatchObject({ state: "not_linked", requests: [] });
    expect(await getGoogleReviewLink(db, globex.ctx)).toBeNull();
  });

  it("refuses an ask from a client without the feature, or an operator viewing as them", async () => {
    expect(await askForGoogleChange(db, globex.ctx, "Change my hours")).toMatchObject({ ok: false });
    const viewing = tenantContextFrom(
      { userId: admin.userId, organizationId: null, role: "admin", status: "active", sessionEpoch: 0 },
      acme.organizationId,
      { impersonating: true },
    );
    await expect(askForGoogleChange(db, viewing, "Change my hours")).rejects.toThrow(/read-only/);
  });
});

describe("the cross-client queue", () => {
  it("lists unanswered reviews worst first, stale posts and profile gaps", async () => {
    seedAcmeOnGoogle(google);
    await connect();
    await linkGoogleLocation(admin, db, acmeClientPublicId, { accountName: "accounts/111", locationName: "locations/456" });

    const queue = await getGoogleQueue(admin, db, { now: new Date("2026-11-01T12:00:00Z") });
    expect(queue.unansweredReviews.map((r) => r.starRating)).toEqual([1, 5]);
    expect(queue.unansweredReviews.every((r) => r.hasDraft)).toBe(true);
    expect(queue.stalePosts).toEqual([{ clientPublicId: acmeClientPublicId, organizationName: "Acme Plumbing", lastPostAt: null }]);
    expect(queue.gaps[0]!.items.map((i) => i.key)).toEqual(["photos", "holiday"]);

    const workspace = await getGoogleWorkspace(admin, db, acmeClientPublicId);
    expect(workspace.hasFeature).toBe(true);
    expect(workspace.reviews[0]!.replyComment).toBeNull();
  });
});
