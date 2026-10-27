import {
  hostOf,
  percent,
  ProviderError,
  type AuditOutcome,
  type Finding,
  type ProviderGrant,
  type ProviderTokens,
  type TokenUpdate,
} from "../types";

/**
 * Instagram, through the "Instagram API with Instagram Login": the client
 * signs in with their Instagram business or creator account, no Facebook
 * Page needed. The token Meta issues is long-lived (60 days) and is renewed
 * at each audit once it is within ten days of expiring, so an account that
 * is looked at monthly never lapses.
 *
 * The audit reads the profile and the last 50 posts. It is about habits —
 * how often they post, whether the bio sends people to the site, whether
 * anyone responds — not about likes for their own sake.
 */

export const INSTAGRAM_CALLBACK_PATH = "/api/connections/instagram/callback";
const SCOPES = ["instagram_business_basic", "instagram_business_manage_insights"];
const AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
const SHORT_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const GRAPH = "https://graph.instagram.com";
const GRAPH_VERSION = "v22.0";
/** Renew the long-lived token this close to its end. */
const RENEW_WITHIN_DAYS = 10;
const MEDIA_LIMIT = 50;

type FetchLike = typeof fetch;

export interface InstagramConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
}

export type InstagramConfigCheck = { ok: true; config: InstagramConfig } | { ok: false; missing: string[] };

export function instagramConfig(env: Record<string, string | undefined> = process.env): InstagramConfigCheck {
  const appId = env.INSTAGRAM_APP_ID?.trim() ?? "";
  const appSecret = env.INSTAGRAM_APP_SECRET?.trim() ?? "";
  const base = env.AUTH_URL?.trim();
  const redirectUri = base ? `${base.replace(/\/$/, "")}${INSTAGRAM_CALLBACK_PATH}` : "";
  const missing = [!appId && "INSTAGRAM_APP_ID", !appSecret && "INSTAGRAM_APP_SECRET", !redirectUri && "AUTH_URL"].filter(
    (name): name is string => Boolean(name),
  );
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, config: { appId, appSecret, redirectUri } };
}

export function instagramAuthorizationUrl(config: InstagramConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.appId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: SCOPES.join(","),
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function readJson<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const kind = response.status === 400 || response.status === 401 || response.status === 403 ? "auth" : "unavailable";
    throw new ProviderError(kind, `Instagram ${what} ${response.status}: ${text.slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

/**
 * The code Instagram sends back, exchanged for a short-lived token and
 * then for the long-lived one that is kept. Instagram appends `#_` to the
 * code on some redirects; it is not part of the code.
 */
export async function exchangeInstagramCode(
  config: InstagramConfig,
  rawCode: string,
  fetchImpl: FetchLike = fetch,
): Promise<ProviderGrant> {
  const code = rawCode.replace(/#_$/, "");
  const short = await readJson<{ access_token: string; user_id: number | string; permissions?: string[] }>(
    await fetchImpl(SHORT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.appId,
        client_secret: config.appSecret,
        grant_type: "authorization_code",
        redirect_uri: config.redirectUri,
        code,
      }).toString(),
    }),
    "code exchange",
  );

  const long = await readJson<{ access_token: string; expires_in: number }>(
    await fetchImpl(
      `${GRAPH}/access_token?${new URLSearchParams({
        grant_type: "ig_exchange_token",
        client_secret: config.appSecret,
        access_token: short.access_token,
      }).toString()}`,
    ),
    "long-lived token",
  );

  const me = await readJson<{ user_id?: string; id?: string; username?: string }>(
    await fetchImpl(`${GRAPH}/${GRAPH_VERSION}/me?fields=user_id,username&access_token=${encodeURIComponent(long.access_token)}`),
    "profile",
  );

  return {
    externalId: String(me.user_id ?? me.id ?? short.user_id),
    displayName: me.username ? `@${me.username}` : null,
    scope: (short.permissions ?? SCOPES).join(" "),
    accessToken: long.access_token,
    refreshToken: null,
    expiresAt: new Date(Date.now() + long.expires_in * 1000),
  };
}

export async function refreshInstagramToken(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ accessToken: string; expiresAt: Date }> {
  const renewed = await readJson<{ access_token: string; expires_in: number }>(
    await fetchImpl(
      `${GRAPH}/refresh_access_token?${new URLSearchParams({ grant_type: "ig_refresh_token", access_token: accessToken }).toString()}`,
    ),
    "token renewal",
  );
  return { accessToken: renewed.access_token, expiresAt: new Date(Date.now() + renewed.expires_in * 1000) };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface InstagramPost {
  id: string;
  timestamp: string;
  mediaType: string;
  likes: number;
  comments: number;
}

export interface InstagramSnapshot {
  username: string | null;
  name: string | null;
  biography: string | null;
  website: string | null;
  followers: number;
  mediaCount: number;
  /** Newest first, up to 50. */
  posts: InstagramPost[];
}

export async function fetchInstagramSnapshot(
  tokens: ProviderTokens,
  context: { now: Date; fetchImpl?: FetchLike },
): Promise<{ snapshot: InstagramSnapshot; update?: TokenUpdate }> {
  const fetchImpl = context.fetchImpl ?? fetch;
  if (!tokens.accessToken) throw new ProviderError("auth", "No Instagram token; reconnect.");
  if (tokens.expiresAt && tokens.expiresAt.getTime() <= context.now.getTime()) {
    throw new ProviderError("auth", "The Instagram token has expired; reconnect.");
  }

  let accessToken = tokens.accessToken;
  let update: TokenUpdate | undefined;
  const renewBefore = context.now.getTime() + RENEW_WITHIN_DAYS * 24 * 60 * 60 * 1000;
  if (!tokens.expiresAt || tokens.expiresAt.getTime() < renewBefore) {
    const renewed = await refreshInstagramToken(accessToken, fetchImpl);
    accessToken = renewed.accessToken;
    update = { accessToken: renewed.accessToken, expiresAt: renewed.expiresAt };
  }

  const token = encodeURIComponent(accessToken);
  const profile = await readJson<{
    username?: string;
    name?: string;
    biography?: string;
    website?: string;
    followers_count?: number;
    media_count?: number;
  }>(
    await fetchImpl(
      `${GRAPH}/${GRAPH_VERSION}/me?fields=username,name,biography,website,followers_count,media_count&access_token=${token}`,
    ),
    "profile",
  );
  const media = await readJson<{
    data?: Array<{ id: string; timestamp: string; media_type: string; like_count?: number; comments_count?: number }>;
  }>(
    await fetchImpl(
      `${GRAPH}/${GRAPH_VERSION}/me/media?fields=id,timestamp,media_type,like_count,comments_count&limit=${MEDIA_LIMIT}&access_token=${token}`,
    ),
    "posts",
  );

  return {
    snapshot: {
      username: profile.username ?? null,
      name: profile.name ?? null,
      biography: profile.biography?.trim() || null,
      website: profile.website?.trim() || null,
      followers: profile.followers_count ?? 0,
      mediaCount: profile.media_count ?? 0,
      posts: (media.data ?? []).map((m) => ({
        id: m.id,
        timestamp: m.timestamp,
        mediaType: m.media_type,
        likes: m.like_count ?? 0,
        comments: m.comments_count ?? 0,
      })),
    },
    update,
  };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** Roughly weekly keeps an account alive in the feed and on the profile. */
const POSTS_PER_MONTH_TARGET = 4;
/** Posts the engagement rate is averaged over: recent enough to describe now. */
const ENGAGEMENT_SAMPLE = 12;
const ENGAGEMENT_LOW_PERCENT = 1;
const MIN_FOLLOWERS_FOR_RATE = 100;

export function auditInstagram(
  snapshot: InstagramSnapshot,
  context: { siteHost: string | null; now: Date; startAt: Date; endAt: Date },
): AuditOutcome["audit"] {
  const findings: Finding[] = [];
  const inWindow = snapshot.posts.filter((p) => {
    const at = Date.parse(p.timestamp);
    return at >= context.startAt.getTime() && at < context.endAt.getTime();
  });
  const newest = snapshot.posts[0] ? Date.parse(snapshot.posts[0].timestamp) : null;
  const daysSincePost = newest ? Math.floor((context.now.getTime() - newest) / (24 * 60 * 60 * 1000)) : null;

  if (daysSincePost === null) {
    findings.push({
      severity: "fix",
      title: "Nothing posted yet",
      detail: "An empty profile reads as a closed business. One photo of a finished job a week is enough to look open.",
    });
  } else if (inWindow.length === 0) {
    findings.push({
      severity: "fix",
      title: `Last post was ${daysSincePost} days ago`,
      detail: "Nothing in the last 30 days. People check Instagram to see whether a business is still active; a job photo a week keeps it current, and Job showcase can make the graphic for you.",
    });
  } else if (inWindow.length < POSTS_PER_MONTH_TARGET) {
    findings.push({
      severity: "improve",
      title: `${inWindow.length} post${inWindow.length === 1 ? "" : "s"} in the last 30 days`,
      detail: `Aim for about ${POSTS_PER_MONTH_TARGET} a month — one a week. Finished jobs, before-and-afters and the team at work are what local customers look for.`,
    });
  } else {
    findings.push({
      severity: "good",
      title: `Posting steadily — ${inWindow.length} in the last 30 days`,
      detail: "Keep it up; consistency matters more than any single post.",
    });
  }

  const bioHost = hostOf(snapshot.website);
  if (!snapshot.website) {
    findings.push({
      severity: "fix",
      title: "No website link in the bio",
      detail: "The bio link is the one place on Instagram that can send someone to your site to call or book. Add it under Edit profile.",
    });
  } else if (context.siteHost && bioHost !== context.siteHost) {
    findings.push({
      severity: "improve",
      title: "The bio link is not your site",
      detail: `It points to ${bioHost ?? snapshot.website}; your site is ${context.siteHost}. Point it at the site so a visitor lands where they can call or book.`,
    });
  }

  if (!snapshot.biography) {
    findings.push({
      severity: "improve",
      title: "The bio is empty",
      detail: "Say what you do and where, in a line — it is what shows in search results on Instagram.",
    });
  }

  const sample = snapshot.posts.slice(0, ENGAGEMENT_SAMPLE);
  if (sample.length >= 3 && snapshot.followers >= MIN_FOLLOWERS_FOR_RATE) {
    const average = sample.reduce((sum, p) => sum + p.likes + p.comments, 0) / sample.length;
    const rate = percent(average, snapshot.followers);
    if (rate < ENGAGEMENT_LOW_PERCENT) {
      findings.push({
        severity: "improve",
        title: `Few responses — ${rate.toFixed(1)}% of followers react to a post`,
        detail: "Under about 1% means the posts are being scrolled past. Faces, real jobs and a question in the caption get more response than stock images and offers.",
      });
    }
    if (!sample.some((p) => p.mediaType === "VIDEO")) {
      findings.push({
        severity: "improve",
        title: "No video in recent posts",
        detail: "Short videos (Reels) are shown to far more people than photos. A 15-second clip of a job in progress, filmed on a phone, is enough.",
      });
    }
  }

  return {
    version: 1,
    at: context.now.toISOString(),
    startAt: context.startAt.toISOString(),
    endAt: context.endAt.toISOString(),
    headline: `${inWindow.length} post${inWindow.length === 1 ? "" : "s"} in 30 days, ${snapshot.followers} followers`,
    rows: [
      { label: "Followers", value: String(snapshot.followers) },
      { label: "Posts in 30 days", value: String(inWindow.length) },
      { label: "Last post", value: daysSincePost === null ? "never" : daysSincePost === 0 ? "today" : `${daysSincePost} days ago` },
      { label: "Bio link", value: snapshot.website ?? "none" },
    ],
    findings,
    snapshot: { ...snapshot },
  };
}
