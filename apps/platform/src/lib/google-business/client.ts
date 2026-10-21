import { errorFromResponse, GoogleApiError } from "./errors";
import {
  DAILY_METRICS,
  dailyRowsFrom,
  keywordCountsFrom,
  periodsFromWeek,
  reviewFrom,
  snapshotFromLocation,
  specialPeriodsFrom,
  type GLocation,
  type GReview,
} from "./normalize";
import type {
  DailyMetricsRow,
  DateRange,
  GoogleInvitation,
  GoogleLocationSummary,
  KeywordCount,
  PostInput,
  ProfileSnapshot,
  PublishedPost,
  ReviewPage,
  SpecialDay,
  WeeklyHours,
} from "./types";

/**
 * The Google Business Profile APIs, as the portal uses them.
 *
 * Five Google services make up "the Business Profile API" now, and the
 * portal needs four of them plus the older v4 API, which still owns reviews,
 * posts and photos:
 *
 *  | What                         | Service                                   |
 *  | ---------------------------- | ----------------------------------------- |
 *  | accounts, manager invites    | mybusinessaccountmanagement.googleapis.com/v1 |
 *  | locations, hours, description| mybusinessbusinessinformation.googleapis.com/v1 |
 *  | daily figures, search terms  | businessprofileperformance.googleapis.com/v1 |
 *  | reviews, posts, photos       | mybusiness.googleapis.com/v4              |
 *
 * DB-free on purpose: this is the seam other features build on (Review
 * requests reads the review link; Job showcase publishes posts) and the one
 * place tests stub, at the HTTP boundary — pass a `fetch` and every call goes
 * through it.
 *
 * Every method throws `GoogleApiError` on failure; nothing here retries. The
 * sync decides what a failure means (back off, pause for quota, give up).
 */

const ACCOUNTS = "https://mybusinessaccountmanagement.googleapis.com/v1";
const INFO = "https://mybusinessbusinessinformation.googleapis.com/v1";
const PERFORMANCE = "https://businessprofileperformance.googleapis.com/v1";
const V4 = "https://mybusiness.googleapis.com/v4";

/** What `getLocation` asks Google for. Everything `snapshotFromLocation` reads. */
const LOCATION_READ_MASK = [
  "name",
  "title",
  "phoneNumbers",
  "categories",
  "storefrontAddress",
  "websiteUri",
  "regularHours",
  "specialHours",
  "profile",
  "openInfo",
  "metadata",
].join(",");

/** Google refuses a page larger than this for locations. */
const LOCATION_PAGE_SIZE = 100;
const REVIEW_PAGE_SIZE = 50;
/** A post summary's limit on Google. */
export const POST_SUMMARY_MAX = 1500;
/** A profile description's limit on Google. */
export const DESCRIPTION_MAX = 750;

type FetchLike = typeof fetch;

export interface GoogleBusinessClient {
  listAccounts(): Promise<Array<{ name: string; accountName: string; type: string }>>;
  listInvitations(accountName: string): Promise<GoogleInvitation[]>;
  acceptInvitation(invitationName: string): Promise<void>;
  listLocations(accountName: string): Promise<GoogleLocationSummary[]>;
  getLocation(locationName: string): Promise<ProfileSnapshot>;
  updateHours(locationName: string, hours: WeeklyHours): Promise<ProfileSnapshot>;
  updateSpecialHours(locationName: string, days: SpecialDay[]): Promise<ProfileSnapshot>;
  updateDescription(locationName: string, description: string): Promise<ProfileSnapshot>;
  listReviews(accountName: string, locationName: string, pageToken?: string | null): Promise<ReviewPage>;
  replyToReview(accountName: string, locationName: string, reviewId: string, comment: string): Promise<{ comment: string; updatedAt: Date | null }>;
  createPost(accountName: string, locationName: string, post: PostInput): Promise<PublishedPost>;
  latestPostAt(accountName: string, locationName: string): Promise<Date | null>;
  addPhoto(accountName: string, locationName: string, sourceUrl: string): Promise<{ name: string }>;
  photoCount(accountName: string, locationName: string): Promise<number | null>;
  dailyMetrics(locationName: string, range: DateRange): Promise<DailyMetricsRow[]>;
  searchKeywords(locationName: string, month: string): Promise<KeywordCount[]>;
}

/** `locations/456` → `456`. The v4 API addresses a location under its account. */
export function locationId(locationName: string): string {
  const id = locationName.split("/").pop();
  if (!id || !/^[\w-]+$/.test(id)) throw new GoogleApiError("invalid", 400, `Not a location name: ${locationName}`);
  return id;
}

function v4Location(accountName: string, locationName: string): string {
  const account = accountName.split("/").pop();
  if (!account || !/^[\w-]+$/.test(account)) throw new GoogleApiError("invalid", 400, `Not an account name: ${accountName}`);
  return `${V4}/accounts/${account}/locations/${locationId(locationName)}`;
}

function resource(name: string, kind: "accounts" | "locations"): string {
  // Names come from Google or our own database, never from a form field
  // directly — but a path segment is still never trusted to be one segment.
  if (!new RegExp(`^${kind}/[\\w-]+$`).test(name)) {
    throw new GoogleApiError("invalid", 400, `Not a ${kind} name: ${name}`);
  }
  return name;
}

function ymdParams(prefix: string, iso: string): Record<string, string> {
  const [year, month, day] = iso.split("-");
  return {
    [`${prefix}.year`]: String(Number(year)),
    [`${prefix}.month`]: String(Number(month)),
    ...(day ? { [`${prefix}.day`]: String(Number(day)) } : {}),
  };
}

export function createGoogleBusinessClient(
  accessToken: string,
  { fetch: fetchImpl = fetch }: { fetch?: FetchLike } = {},
): GoogleBusinessClient {
  async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
      });
    } catch (error) {
      throw new GoogleApiError("unavailable", 0, error instanceof Error ? error.message : "Network error");
    }
    if (!response.ok) throw await errorFromResponse(response);
    if (response.status === 204) return {} as T;
    return (await response.json()) as T;
  }

  function withQuery(url: string, params: Record<string, string | string[]>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      for (const v of Array.isArray(value) ? value : [value]) search.append(key, v);
    }
    return `${url}?${search.toString()}`;
  }

  async function patchLocation(locationName: string, updateMask: string, body: GLocation): Promise<ProfileSnapshot> {
    await call(withQuery(`${INFO}/${resource(locationName, "locations")}`, { updateMask }), {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    // The PATCH answers with only the masked fields, so re-read the whole
    // profile: the snapshot the portal stores must be Google's, not a merge.
    return client.getLocation(locationName);
  }

  const client: GoogleBusinessClient = {
    async listAccounts() {
      const accounts: Array<{ name: string; accountName: string; type: string }> = [];
      let pageToken: string | undefined;
      do {
        const page = await call<{
          accounts?: Array<{ name?: string; accountName?: string; type?: string }>;
          nextPageToken?: string;
        }>(withQuery(`${ACCOUNTS}/accounts`, { pageSize: "20", ...(pageToken ? { pageToken } : {}) }));
        for (const a of page.accounts ?? []) {
          if (a.name) accounts.push({ name: a.name, accountName: a.accountName ?? a.name, type: a.type ?? "" });
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
      return accounts;
    },

    async listInvitations(accountName) {
      const page = await call<{
        invitations?: Array<{
          name?: string;
          role?: string;
          targetLocation?: { locationName?: string; address?: string };
          targetAccount?: { accountName?: string };
        }>;
      }>(`${ACCOUNTS}/${resource(accountName, "accounts")}/invitations`);
      return (page.invitations ?? [])
        .filter((i): i is typeof i & { name: string } => Boolean(i.name))
        .map((i) => ({
          name: i.name,
          role: i.role ?? "",
          target:
            [i.targetLocation?.locationName, i.targetLocation?.address].filter(Boolean).join(", ") ||
            i.targetAccount?.accountName ||
            "A Business Profile",
        }));
    },

    async acceptInvitation(invitationName) {
      if (!/^accounts\/[\w-]+\/invitations\/[\w-]+$/.test(invitationName)) {
        throw new GoogleApiError("invalid", 400, `Not an invitation name: ${invitationName}`);
      }
      await call(`${ACCOUNTS}/${invitationName}:accept`, { method: "POST", body: "{}" });
    },

    async listLocations(accountName) {
      const locations: GoogleLocationSummary[] = [];
      let pageToken: string | undefined;
      do {
        const page = await call<{ locations?: GLocation[]; nextPageToken?: string }>(
          withQuery(`${INFO}/${resource(accountName, "accounts")}/locations`, {
            readMask: "name,title,storefrontAddress",
            pageSize: String(LOCATION_PAGE_SIZE),
            ...(pageToken ? { pageToken } : {}),
          }),
        );
        for (const location of page.locations ?? []) {
          if (!location.name) continue;
          const snapshot = snapshotFromLocation(location);
          locations.push({
            name: location.name,
            accountName,
            title: snapshot.title ?? location.name,
            address: snapshot.address,
          });
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
      return locations;
    },

    async getLocation(locationName) {
      const location = await call<GLocation>(
        withQuery(`${INFO}/${resource(locationName, "locations")}`, { readMask: LOCATION_READ_MASK }),
      );
      return snapshotFromLocation(location);
    },

    updateHours(locationName, hours) {
      return patchLocation(locationName, "regularHours", { regularHours: { periods: periodsFromWeek(hours) } });
    },

    updateSpecialHours(locationName, days) {
      return patchLocation(locationName, "specialHours", {
        specialHours: { specialHourPeriods: specialPeriodsFrom(days) },
      });
    },

    updateDescription(locationName, description) {
      return patchLocation(locationName, "profile.description", { profile: { description } });
    },

    async listReviews(accountName, locationName, pageToken) {
      const page = await call<{
        reviews?: GReview[];
        averageRating?: number;
        totalReviewCount?: number;
        nextPageToken?: string;
      }>(
        withQuery(`${v4Location(accountName, locationName)}/reviews`, {
          pageSize: String(REVIEW_PAGE_SIZE),
          orderBy: "updateTime desc",
          ...(pageToken ? { pageToken } : {}),
        }),
      );
      return {
        reviews: (page.reviews ?? []).map(reviewFrom).filter((r): r is NonNullable<typeof r> => r !== null),
        averageRating: typeof page.averageRating === "number" ? page.averageRating : null,
        totalReviewCount: typeof page.totalReviewCount === "number" ? page.totalReviewCount : null,
        nextPageToken: page.nextPageToken ?? null,
      };
    },

    async replyToReview(accountName, locationName, reviewId, comment) {
      if (!/^[\w-]+$/.test(reviewId)) throw new GoogleApiError("invalid", 400, "Not a review id.");
      const reply = await call<{ comment?: string; updateTime?: string }>(
        `${v4Location(accountName, locationName)}/reviews/${reviewId}/reply`,
        { method: "PUT", body: JSON.stringify({ comment }) },
      );
      return {
        comment: reply.comment ?? comment,
        updatedAt: reply.updateTime ? new Date(reply.updateTime) : null,
      };
    },

    async createPost(accountName, locationName, post) {
      const created = await call<{ name?: string; state?: string; searchUrl?: string; createTime?: string }>(
        `${v4Location(accountName, locationName)}/localPosts`,
        {
          method: "POST",
          body: JSON.stringify({
            languageCode: "en-US",
            topicType: "STANDARD",
            summary: post.summary,
            ...(post.cta
              ? {
                  callToAction:
                    post.cta.type === "CALL"
                      ? { actionType: "CALL" }
                      : { actionType: post.cta.type, url: post.cta.url },
                }
              : {}),
            ...(post.photoUrl ? { media: [{ mediaFormat: "PHOTO", sourceUrl: post.photoUrl }] } : {}),
          }),
        },
      );
      if (!created.name) throw new GoogleApiError("unavailable", 200, "Google did not return the new post.");
      return {
        name: created.name,
        state: created.state ?? null,
        searchUrl: created.searchUrl ?? null,
        createdAt: created.createTime ? new Date(created.createTime) : null,
      };
    },

    async latestPostAt(accountName, locationName) {
      const page = await call<{ localPosts?: Array<{ createTime?: string; state?: string }> }>(
        withQuery(`${v4Location(accountName, locationName)}/localPosts`, { pageSize: "10" }),
      );
      const times = (page.localPosts ?? [])
        .map((p) => (p.createTime ? new Date(p.createTime).getTime() : NaN))
        .filter((t) => Number.isFinite(t));
      return times.length > 0 ? new Date(Math.max(...times)) : null;
    },

    async addPhoto(accountName, locationName, sourceUrl) {
      const created = await call<{ name?: string }>(`${v4Location(accountName, locationName)}/media`, {
        method: "POST",
        body: JSON.stringify({
          mediaFormat: "PHOTO",
          locationAssociation: { category: "ADDITIONAL" },
          sourceUrl,
        }),
      });
      if (!created.name) throw new GoogleApiError("unavailable", 200, "Google did not return the new photo.");
      return { name: created.name };
    },

    async photoCount(accountName, locationName) {
      const page = await call<{ totalMediaItemCount?: number; mediaItems?: unknown[] }>(
        withQuery(`${v4Location(accountName, locationName)}/media`, { pageSize: "1" }),
      );
      return typeof page.totalMediaItemCount === "number" ? page.totalMediaItemCount : null;
    },

    async dailyMetrics(locationName, range) {
      const response = await call<Parameters<typeof dailyRowsFrom>[0]>(
        withQuery(`${PERFORMANCE}/${resource(locationName, "locations")}:fetchMultiDailyMetricsTimeSeries`, {
          dailyMetrics: DAILY_METRICS,
          ...ymdParams("dailyRange.start_date", range.start),
          ...ymdParams("dailyRange.end_date", range.end),
        }),
      );
      return dailyRowsFrom(response);
    },

    async searchKeywords(locationName, month) {
      const counts: KeywordCount[] = [];
      let pageToken: string | undefined;
      do {
        const page = await call<Parameters<typeof keywordCountsFrom>[0] & { nextPageToken?: string }>(
          withQuery(`${PERFORMANCE}/${resource(locationName, "locations")}/searchkeywords/impressions/monthly`, {
            ...ymdParams("monthlyRange.start_month", month.slice(0, 7)),
            ...ymdParams("monthlyRange.end_month", month.slice(0, 7)),
            pageSize: "100",
            ...(pageToken ? { pageToken } : {}),
          }),
        );
        counts.push(...keywordCountsFrom(page));
        pageToken = page.nextPageToken;
        // Ten pages is a thousand search terms — more than any small
        // business profile has, and a bound on what one sync can spend.
      } while (pageToken && counts.length < 1000);
      return counts;
    },
  };

  return client;
}
