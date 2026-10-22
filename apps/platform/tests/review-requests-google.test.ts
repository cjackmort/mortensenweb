import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { clients, googleConnections, googleLocations, reviewRequests, reviewSettings, users } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { adminContextFrom, type AdminContext } from "@/db/repositories/context";
import { completeGoogleConnect, resetGoogleTokenCache } from "@/db/repositories/admin/google-connection";
import { linkGoogleLocation } from "@/db/repositories/admin/google-edits";
import { getClientReviews, recordReviewClick } from "@/db/repositories/admin/reviews";
import { getGoogleReviewStats } from "@/db/repositories/client/google-profile";
import { getReviewDestination, saveReviewLink } from "@/db/repositories/client/reviews";
import { sendReviewRequest } from "@/db/repositories/client/review-send";
import type { EmailMessage, SendResult } from "@/lib/email/mailer";
import { reviewStatsSource, type ReviewStatsResult } from "@/lib/reviews/stats";
import { createTestDb } from "./helpers/db";
import { fakeGoogle, sampleLocation, type FakeGoogle, type FakeLocation } from "./helpers/google-fake";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * Review requests with a linked Google Business Profile, against a fake
 * Google at the HTTP boundary and the real migrations on PGlite.
 *
 * The quiet failures: a customer sent to the hand-entered link after Google
 * gave the profile its own review form; one business's customers sent to
 * another business's profile; a link from the profile copy redirected to
 * without the check a pasted link gets; and a profile that never synced shown
 * as the rating's source, hiding the Places figure that was there.
 */

const ENTERED_PLACE = "ChIJN1t_tDeuEmsRUsoyG83frY4";
const ENTERED_REVIEW = `https://search.google.com/local/writereview?placeid=${ENTERED_PLACE}`;
const PROFILE_PLACE = "ChIJ_acme_profile_place_01";
const PROFILE_REVIEW = `https://search.google.com/local/writereview?placeid=${PROFILE_PLACE}`;

const ENV = {
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  GOOGLE_TOKEN_KEY: Buffer.alloc(32, 3).toString("base64"),
  AUTH_URL: "https://portal.example",
  AUTH_SECRET: "test-secret-that-is-long-enough-for-hmac",
  RESEND_FROM_ADDRESS: '"Mortensen Web Co." <hello@mortensenweb.example>',
};
const SENT_AT = new Date("2026-10-17T18:00:00Z"); // noon in Denver
const savedEnv: Record<string, string | undefined> = {};

let db: Database;
let close: () => Promise<void>;
let admin: AdminContext;
let acme: SeededTenant;
let globex: SeededTenant;
let google: FakeGoogle;

const delivered = async (_message: EmailMessage): Promise<SendResult> => ({ status: "sent", id: "re_1" });

async function clientPublicIdOf(tenant: SeededTenant): Promise<string> {
  const [row] = await db.select({ publicId: clients.publicId }).from(clients).where(eq(clients.id, tenant.clientId));
  return row!.publicId;
}

function acmeProfile(metadata: FakeLocation["metadata"] = { newReviewUri: PROFILE_REVIEW, placeId: PROFILE_PLACE }) {
  return sampleLocation("456", { metadata });
}

async function link(tenant: SeededTenant, location: FakeLocation) {
  google.addLocation(location);
  const result = await linkGoogleLocation(admin, db, await clientPublicIdOf(tenant), {
    accountName: "accounts/111",
    locationName: location.name,
  });
  expect(result.ok).toBe(true);
  return result;
}

/** Send Acme's customer a request and click its link: where does it go? */
async function clickedThrough(tenant: SeededTenant = acme): Promise<string | null> {
  const sent = await sendReviewRequest(
    db,
    tenant.ctx,
    { name: "Dana Reyes", email: "dana@example.test" },
    { send: delivered, smsEnabled: false, now: SENT_AT, env: ENV },
  );
  expect(sent.ok).toBe(true);
  const [row] = await db
    .select({ publicId: reviewRequests.publicId })
    .from(reviewRequests)
    .where(eq(reviewRequests.organizationId, tenant.organizationId));
  return recordReviewClick(db, row!.publicId, new Date(SENT_AT.getTime() + 60_000));
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const [adminUser] = await db
    .insert(users)
    .values({ publicId: newPublicId(), email: "operator@example.test", name: "Scott", role: "admin", status: "active" })
    .returning({ id: users.id });
  admin = adminContextFrom({ userId: adminUser!.id, organizationId: null, role: "admin", status: "active", sessionEpoch: 0 });
  acme = await seedTenant(db, "Acme Plumbing");
  globex = await seedTenant(db, "Globex Roofing");

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
  await db.delete(reviewRequests);
  await db.delete(reviewSettings);
  await db.delete(googleLocations);
  await db.delete(googleConnections);
  await completeGoogleConnect(admin, db, { code: "code", codeVerifier: "verifier" });
  await saveReviewLink(db, acme.ctx, { input: ENTERED_PLACE }, { lookup: null });
  await saveReviewLink(db, globex.ctx, { input: ENTERED_PLACE }, { lookup: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the link in a review request", () => {
  it("goes to the link the business entered while no profile is linked", async () => {
    expect(await clickedThrough()).toBe(ENTERED_REVIEW);
  });

  it("goes to the review form Google gives the business's linked profile", async () => {
    await link(acme, acmeProfile());
    expect(await clickedThrough()).toBe(PROFILE_REVIEW);
  });

  it("follows the profile in emails already sent, because the link is resolved on the click", async () => {
    const sent = await sendReviewRequest(
      db,
      acme.ctx,
      { name: "Dana Reyes", email: "dana@example.test" },
      { send: delivered, smsEnabled: false, now: SENT_AT, env: ENV },
    );
    expect(sent.ok).toBe(true);
    await link(acme, acmeProfile());
    const [row] = await db.select({ publicId: reviewRequests.publicId }).from(reviewRequests);
    expect(await recordReviewClick(db, row!.publicId, new Date(SENT_AT.getTime() + 60_000))).toBe(PROFILE_REVIEW);
  });

  it("keeps the entered link when Google gave the profile no review form", async () => {
    await link(acme, acmeProfile({ placeId: PROFILE_PLACE }));
    expect(await clickedThrough()).toBe(ENTERED_REVIEW);
  });

  it("never redirects to a profile link that fails the check a pasted link gets", async () => {
    await link(acme, acmeProfile({ newReviewUri: "https://evil.example/local/writereview?placeid=x" }));
    expect(await clickedThrough()).toBe(ENTERED_REVIEW);
  });

  it("never sends one business's customers to another business's profile", async () => {
    await link(acme, acmeProfile());
    expect(await clickedThrough(globex)).toBe(ENTERED_REVIEW);
  });
});

describe("what the client and the operator are told about the link", () => {
  it("says customers go to the profile's review form once it is linked", async () => {
    await link(acme, acmeProfile());
    expect(await getReviewDestination(db, acme.ctx, ENTERED_REVIEW)).toEqual({ url: PROFILE_REVIEW, from: "profile" });
    expect(await getReviewDestination(db, globex.ctx, ENTERED_REVIEW)).toEqual({ url: ENTERED_REVIEW, from: "entered" });
  });

  it("offers the profile's link before the business has set one up", async () => {
    await link(acme, acmeProfile());
    expect(await getReviewDestination(db, acme.ctx, null)).toEqual({ url: PROFILE_REVIEW, from: "profile" });
    expect(await getReviewDestination(db, globex.ctx, null)).toBeNull();
  });

  it("shows the operator the same destination the customer gets", async () => {
    await link(acme, acmeProfile());
    const acmeView = await getClientReviews(admin, db, await clientPublicIdOf(acme));
    const globexView = await getClientReviews(admin, db, await clientPublicIdOf(globex));
    expect(acmeView.destination).toEqual({ url: PROFILE_REVIEW, from: "profile" });
    expect(globexView.destination).toEqual({ url: ENTERED_REVIEW, from: "entered" });
  });
});

describe("the Google rating on the requests page", () => {
  const fromPlaces: ReviewStatsResult = { ok: true, stats: { rating: 4.2, reviewCount: 17, source: "Google Maps" } };

  function ratingFor(tenant: SeededTenant, places = vi.fn(async () => fromPlaces)) {
    return { places, result: reviewStatsSource({ linkedProfile: () => getGoogleReviewStats(db, tenant.ctx), places })({ placeId: ENTERED_PLACE }) };
  }

  it("comes from the linked profile once it has synced, without spending a Places call", async () => {
    google.state.averageRating.set("locations/456", 4.5);
    google.addReview("locations/456", {
      reviewId: "rev-1",
      reviewer: { displayName: "Dana Smith" },
      starRating: "FIVE",
      createTime: "2026-10-10T15:00:00Z",
    });
    google.addReview("locations/456", {
      reviewId: "rev-2",
      reviewer: { displayName: "Lee Park" },
      starRating: "FOUR",
      createTime: "2026-10-12T15:00:00Z",
    });
    await link(acme, acmeProfile());

    const { places, result } = ratingFor(acme);
    expect(await result).toEqual({ ok: true, stats: { rating: 4.5, reviewCount: 2, source: "Google Business Profile" } });
    expect(places).not.toHaveBeenCalled();
  });

  it("falls back to Places while the profile is linked but has never synced", async () => {
    // The project as it stands: Business Information answers, the v4 reviews API is not enabled.
    google.failWhen((c) => c.url.host === "mybusiness.googleapis.com", 403, {
      error: {
        code: 403,
        message: "Google My Business API has not been used in project 1 before or it is disabled.",
        status: "PERMISSION_DENIED",
        details: [{ reason: "SERVICE_DISABLED" }],
      },
    }, { times: 10 });
    const linked = await link(acme, acmeProfile());
    expect(linked.message).toMatch(/did not finish/);

    const { places, result } = ratingFor(acme);
    expect(await result).toEqual(fromPlaces);
    expect(places).toHaveBeenCalledWith({ placeId: ENTERED_PLACE });
  });

  it("falls back to Places for a business with no linked profile", async () => {
    await link(acme, acmeProfile());
    const { result } = ratingFor(globex);
    expect(await result).toEqual(fromPlaces);
  });
});
