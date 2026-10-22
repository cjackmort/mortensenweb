/**
 * A fake Google, at the HTTP boundary.
 *
 * Stands in for every Google endpoint the portal calls — OAuth, Account
 * Management, Business Information, Performance and the v4 reviews / posts /
 * media API — with just enough state to answer the way Google does: a PATCH
 * changes what the next GET returns, a reply shows up on the review. Install it
 * with `vi.stubGlobal("fetch", google.fetch)` or pass `google.fetch` directly.
 *
 * Shapes follow Google's documented JSON, including its habit of omitting
 * zeros (`openTime: {}` is midnight, a dated value with no `value` is 0), so
 * the normalisers are tested against what Google actually sends.
 */

export interface FakeCall {
  method: string;
  url: URL;
  body: unknown;
  authorization: string | null;
}

interface Failure {
  match: (call: FakeCall) => boolean;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  times: number;
}

export interface FakeLocation {
  name: string;
  title: string;
  phoneNumbers?: { primaryPhone?: string };
  categories?: { primaryCategory?: { displayName?: string }; additionalCategories?: Array<{ displayName?: string }> };
  storefrontAddress?: { addressLines?: string[]; locality?: string; administrativeArea?: string; postalCode?: string };
  websiteUri?: string;
  regularHours?: { periods: unknown[] };
  specialHours?: { specialHourPeriods: unknown[] };
  profile?: { description?: string };
  openInfo?: { status?: string };
  metadata?: { mapsUri?: string; newReviewUri?: string; placeId?: string; hasPendingEdits?: boolean };
}

export interface FakeReview {
  reviewId: string;
  reviewer: { displayName?: string; isAnonymous?: boolean };
  starRating: string;
  comment?: string;
  createTime: string;
  updateTime?: string;
  reviewReply?: { comment: string; updateTime: string };
}

export function sampleLocation(id = "456", overrides: Partial<FakeLocation> = {}): FakeLocation {
  return {
    name: `locations/${id}`,
    title: "Acme Plumbing",
    phoneNumbers: { primaryPhone: "(801) 555-0100" },
    categories: {
      primaryCategory: { displayName: "Plumber" },
      additionalCategories: [{ displayName: "Water heater installation service" }],
    },
    storefrontAddress: {
      addressLines: ["12 Main St"],
      locality: "Riverton",
      administrativeArea: "UT",
      postalCode: "84065",
    },
    websiteUri: "https://acmeplumbing.example",
    regularHours: {
      periods: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"].map((day) => ({
        openDay: day,
        openTime: { hours: 8 },
        closeDay: day,
        closeTime: { hours: 17 },
      })),
    },
    specialHours: { specialHourPeriods: [] },
    profile: { description: "Family plumbing in Riverton: repairs, drains and water heaters." },
    openInfo: { status: "OPEN" },
    metadata: {
      mapsUri: `https://maps.google.com/?cid=${id}`,
      newReviewUri: `https://search.google.com/local/writereview?placeid=place-${id}`,
      placeId: `place-${id}`,
    },
    ...overrides,
  };
}

export function fakeGoogle(options: { accountName?: string } = {}) {
  const account = options.accountName ?? "accounts/111";
  const calls: FakeCall[] = [];
  const failures: Failure[] = [];

  const state = {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    identity: { sub: "google-sub-1", email: "agency@example.test" },
    grantedScope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/business.manage",
    revoked: [] as string[],
    accounts: [{ name: account, accountName: "Mortensen Web Co.", type: "PERSONAL" }],
    invitations: [] as Array<{ name: string; role: string; targetLocation?: { locationName?: string; address?: string } }>,
    locations: new Map<string, FakeLocation>(),
    reviews: new Map<string, FakeReview[]>(),
    averageRating: new Map<string, number>(),
    posts: new Map<string, Array<{ name: string; summary: string; createTime: string; state: string; body: unknown }>>(),
    media: new Map<string, Array<{ name: string; sourceUrl: string }>>(),
    /** Per location: date → metric → value. */
    metrics: new Map<string, Map<string, Record<string, number>>>(),
    /** Per location: YYYY-MM → [{ keyword, value | threshold }]. */
    keywords: new Map<string, Map<string, Array<{ keyword: string; value?: number; threshold?: number }>>>(),
  };

  function addLocation(location: FakeLocation) {
    state.locations.set(location.name, location);
    return location;
  }

  function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  }

  function notFound(): Response {
    return json(404, { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } });
  }

  function idOf(path: string, marker: string): string | null {
    const match = path.match(new RegExp(`/${marker}/([^/:]+)`));
    return match ? match[1]! : null;
  }

  function route(call: FakeCall): Response {
    const { method, url } = call;
    const host = url.host;
    const path = url.pathname;

    // ---- OAuth -----------------------------------------------------------
    if (host === "oauth2.googleapis.com" && path === "/token") {
      const form = new URLSearchParams(String(call.body ?? ""));
      if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") !== state.refreshToken) {
        return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
      }
      return json(200, {
        access_token: state.accessToken,
        expires_in: 3599,
        scope: state.grantedScope,
        token_type: "Bearer",
        ...(form.get("grant_type") === "authorization_code" ? { refresh_token: state.refreshToken } : {}),
      });
    }
    if (host === "oauth2.googleapis.com" && path === "/revoke") {
      state.revoked.push(new URLSearchParams(String(call.body ?? "")).get("token") ?? "");
      return json(200, {});
    }
    if (host === "openidconnect.googleapis.com") return json(200, state.identity);

    if (call.authorization !== `Bearer ${state.accessToken}`) {
      return json(401, { error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } });
    }

    // ---- Account Management ---------------------------------------------
    if (host === "mybusinessaccountmanagement.googleapis.com") {
      if (method === "GET" && path === "/v1/accounts") return json(200, { accounts: state.accounts });
      if (method === "GET" && path.endsWith("/invitations")) return json(200, { invitations: state.invitations });
      if (method === "POST" && path.endsWith(":accept")) {
        const name = path.slice("/v1/".length, -":accept".length);
        const before = state.invitations.length;
        state.invitations = state.invitations.filter((i) => i.name !== name);
        return before === state.invitations.length ? notFound() : json(200, {});
      }
    }

    // ---- Business Information --------------------------------------------
    if (host === "mybusinessbusinessinformation.googleapis.com") {
      if (method === "GET" && /\/v1\/accounts\/[^/]+\/locations$/.test(path)) {
        return json(200, { locations: [...state.locations.values()].map((l) => ({ name: l.name, title: l.title, storefrontAddress: l.storefrontAddress })) });
      }
      const name = `locations/${idOf(path, "locations")}`;
      const location = state.locations.get(name);
      if (!location) return notFound();
      if (method === "GET") return json(200, location);
      if (method === "PATCH") {
        const mask = url.searchParams.get("updateMask") ?? "";
        const body = call.body as Partial<FakeLocation>;
        const next: FakeLocation = { ...location };
        if (mask.includes("regularHours")) next.regularHours = body.regularHours;
        if (mask.includes("specialHours")) next.specialHours = body.specialHours;
        if (mask.includes("profile.description")) next.profile = { ...location.profile, description: body.profile?.description };
        state.locations.set(name, next);
        return json(200, body);
      }
    }

    // ---- v4: reviews, posts, media --------------------------------------
    if (host === "mybusiness.googleapis.com") {
      const name = `locations/${idOf(path, "locations")}`;
      if (!state.locations.has(name)) return notFound();

      if (path.includes("/reviews")) {
        const reviews = state.reviews.get(name) ?? [];
        if (method === "PUT" && path.endsWith("/reply")) {
          const reviewId = idOf(path, "reviews");
          const review = reviews.find((r) => r.reviewId === reviewId);
          if (!review) return notFound();
          const updateTime = new Date().toISOString();
          review.reviewReply = { comment: (call.body as { comment: string }).comment, updateTime };
          return json(200, review.reviewReply);
        }
        const pageSize = Number(url.searchParams.get("pageSize") ?? 50);
        const start = Number(url.searchParams.get("pageToken") ?? 0);
        const page = reviews.slice(start, start + pageSize);
        return json(200, {
          reviews: page,
          averageRating: state.averageRating.get(name),
          totalReviewCount: reviews.length,
          ...(start + pageSize < reviews.length ? { nextPageToken: String(start + pageSize) } : {}),
        });
      }

      if (path.endsWith("/localPosts")) {
        const posts = state.posts.get(name) ?? [];
        if (method === "POST") {
          const body = call.body as { summary: string };
          const post = {
            name: `${path.slice("/v4/".length)}/${posts.length + 1}`,
            summary: body.summary,
            createTime: new Date().toISOString(),
            state: "LIVE",
            body,
          };
          state.posts.set(name, [post, ...posts]);
          return json(200, { ...post, searchUrl: `https://local.google.com/place?post=${posts.length + 1}` });
        }
        return json(200, { localPosts: posts.map(({ name: n, createTime, state: s }) => ({ name: n, createTime, state: s })) });
      }

      if (path.endsWith("/media")) {
        const media = state.media.get(name) ?? [];
        if (method === "POST") {
          const item = { name: `${path.slice("/v4/".length)}/${media.length + 1}`, sourceUrl: (call.body as { sourceUrl: string }).sourceUrl };
          state.media.set(name, [...media, item]);
          return json(200, item);
        }
        return json(200, { mediaItems: media.slice(0, 1), totalMediaItemCount: media.length });
      }
    }

    // ---- Performance ------------------------------------------------------
    if (host === "businessprofileperformance.googleapis.com") {
      const name = `locations/${idOf(path, "locations")}`;
      if (!state.locations.has(name)) return notFound();

      if (path.endsWith(":fetchMultiDailyMetricsTimeSeries")) {
        const q = url.searchParams;
        const day = (prefix: string) =>
          `${q.get(`${prefix}.year`)}-${String(q.get(`${prefix}.month`)).padStart(2, "0")}-${String(q.get(`${prefix}.day`)).padStart(2, "0")}`;
        const start = day("dailyRange.start_date");
        const end = day("dailyRange.end_date");
        const byDate = state.metrics.get(name) ?? new Map();
        const dates = [...byDate.keys()].filter((d) => d >= start && d <= end).sort();
        return json(200, {
          multiDailyMetricTimeSeries: [
            {
              dailyMetricTimeSeries: q.getAll("dailyMetrics").map((metric) => ({
                dailyMetric: metric,
                timeSeries: {
                  datedValues: dates.map((d) => {
                    const [y, m, dd] = d.split("-").map(Number);
                    const value = byDate.get(d)?.[metric] ?? 0;
                    // Google omits `value` for zero.
                    return value ? { date: { year: y, month: m, day: dd }, value: String(value) } : { date: { year: y, month: m, day: dd } };
                  }),
                },
              })),
            },
          ],
        });
      }

      if (path.endsWith("/searchkeywords/impressions/monthly")) {
        const q = url.searchParams;
        const month = `${q.get("monthlyRange.start_month.year")}-${String(q.get("monthlyRange.start_month.month")).padStart(2, "0")}`;
        const rows = state.keywords.get(name)?.get(month) ?? [];
        return json(200, {
          searchKeywordsCounts: rows.map((r) => ({
            searchKeyword: r.keyword,
            insightsValue: r.value !== undefined ? { value: String(r.value) } : { threshold: String(r.threshold) },
          })),
        });
      }
    }

    return json(404, { error: { code: 404, message: `No fake for ${method} ${url}`, status: "NOT_FOUND" } });
  }

  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    let body: unknown = init.body ?? null;
    if (typeof body === "string" && headers.get("content-type")?.includes("json")) body = JSON.parse(body);
    const call: FakeCall = { method, url, body, authorization: headers.get("authorization") };
    calls.push(call);

    const failure = failures.find((f) => f.times > 0 && f.match(call));
    if (failure) {
      failure.times -= 1;
      return json(failure.status, failure.body, failure.headers);
    }
    return route(call);
  };

  return {
    fetch: fetchImpl as typeof fetch,
    calls,
    state,
    account,
    addLocation,
    addReview(locationName: string, review: FakeReview) {
      state.reviews.set(locationName, [...(state.reviews.get(locationName) ?? []), review]);
    },
    setMetric(locationName: string, date: string, metric: string, value: number) {
      const byDate = state.metrics.get(locationName) ?? new Map<string, Record<string, number>>();
      byDate.set(date, { ...(byDate.get(date) ?? {}), [metric]: value });
      state.metrics.set(locationName, byDate);
    },
    setKeywords(locationName: string, month: string, rows: Array<{ keyword: string; value?: number; threshold?: number }>) {
      const byMonth = state.keywords.get(locationName) ?? new Map();
      byMonth.set(month, rows);
      state.keywords.set(locationName, byMonth);
    },
    /** Make the next `times` matching calls fail with this status and body. */
    failWhen(
      match: (call: FakeCall) => boolean,
      status: number,
      body: unknown,
      { times = 1, headers }: { times?: number; headers?: Record<string, string> } = {},
    ) {
      failures.push({ match, status, body, headers, times });
    },
    callsTo(host: string) {
      return calls.filter((c) => c.url.host === host);
    },
  };
}

export type FakeGoogle = ReturnType<typeof fakeGoogle>;

export const QUOTA_ERROR = {
  error: {
    code: 429,
    message: "Quota exceeded for quota metric 'Requests' and limit 'Requests per minute'.",
    status: "RESOURCE_EXHAUSTED",
    details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED" }],
  },
};
