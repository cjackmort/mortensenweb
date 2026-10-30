import type { GoogleBusinessConfig } from "@/lib/google-business/config";
import { exchangeCode, fetchIdentity } from "@/lib/google-business/oauth";
import { connectionTokenKey } from "../seal";
import {
  ProviderError,
  type Audit,
  type ProviderGrant,
  type ProviderTokens,
  type TokenUpdate,
} from "../types";
import { usableAccessToken } from "./google";

/**
 * Google Calendar, for busy times only: when the client is not free, so the
 * website does not offer those times for booking.
 *
 * ## Least privilege
 *
 * The scope is `calendar.freebusy` — "see the availability on Google
 * Calendars you have access to". It answers one question, busy or free, for
 * a window: no event titles, places, guests or descriptions, and no writing.
 * That is everything the slot engine needs, so nothing wider is asked for.
 *
 * What it cannot do is list the client's calendars, so the one read is their
 * primary calendar, whose id is the account's email address — free/busy's
 * documentation does not promise the `primary` alias other methods take, so
 * the address is used. Choosing among several calendars would need
 * `calendar.calendarlist.readonly` as well; writing confirmed bookings into
 * the calendar would need `calendar.events`. Neither is requested.
 *
 * ## Same Google client, separate grant
 *
 * The same OAuth client as Search Console, with its own callback and its own
 * consent, stored as its own connection (`google_calendar`). Connecting one
 * never widens the other.
 */

export const CALENDAR_FREEBUSY_SCOPE = "https://www.googleapis.com/auth/calendar.freebusy";
export const GOOGLE_CALENDAR_CALLBACK_PATH = "/api/connections/google_calendar/callback";
export const CALENDAR_REQUESTED_SCOPES = ["openid", "email", CALENDAR_FREEBUSY_SCOPE].join(" ");
const FREEBUSY_ENDPOINT = "https://www.googleapis.com/calendar/v3/freeBusy";
/** Free/busy is asked a month at a time; a longer window is split. */
export const FREEBUSY_CHUNK_DAYS = 31;
/** What the daily health check looks at. */
const CHECK_DAYS = 7;
const DAY_MS = 86_400_000;

type FetchLike = typeof fetch;

export type GoogleCalendarConfig =
  | { ok: true; config: GoogleBusinessConfig }
  | { ok: false; missing: string[] };

export function googleCalendarConfig(env: Record<string, string | undefined> = process.env): GoogleCalendarConfig {
  const clientId = env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  const base = env.AUTH_URL?.trim();
  const redirectUri = base ? `${base.replace(/\/$/, "")}${GOOGLE_CALENDAR_CALLBACK_PATH}` : "";
  const tokenKey = connectionTokenKey(env) ?? "";
  const missing = [
    !clientId && "GOOGLE_CLIENT_ID",
    !clientSecret && "GOOGLE_CLIENT_SECRET",
    !redirectUri && "AUTH_URL",
    !tokenKey && "CONNECTION_TOKEN_KEY",
  ].filter((name): name is string => Boolean(name));
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, config: { clientId, clientSecret, redirectUri, tokenKey } };
}

export async function exchangeCalendarCode(
  config: GoogleBusinessConfig,
  code: string,
  codeVerifier: string,
  fetchImpl: FetchLike = fetch,
): Promise<ProviderGrant> {
  let grant;
  try {
    grant = await exchangeCode(config, code, codeVerifier, fetchImpl);
  } catch (error) {
    throw new ProviderError("auth", error instanceof Error ? error.message : "Google refused the code.");
  }
  // Google lets a person untick a scope on the consent screen.
  if (!grant.scope.split(/\s+/).includes(CALENDAR_FREEBUSY_SCOPE)) {
    throw new ProviderError("auth", "Calendar access was not granted.");
  }
  if (!grant.refreshToken) throw new ProviderError("auth", "Google issued no refresh token.");
  const identity = await fetchIdentity(grant.accessToken, fetchImpl);
  return {
    externalId: identity.subject,
    displayName: identity.email,
    scope: grant.scope,
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    expiresAt: grant.expiresAt,
  };
}

export interface BusyInterval {
  start: Date;
  end: Date;
}

interface FreeBusyResponse {
  calendars?: Record<string, { busy?: Array<{ start?: string; end?: string }>; errors?: Array<{ reason?: string }> }>;
}

/** Rate limits come back as 403 too; only a real refusal means reconnect. */
function errorKind(status: number, body: string): "auth" | "unavailable" {
  if (status === 401) return "auth";
  if (status === 403 && !/rateLimitExceeded|quotaExceeded|RESOURCE_EXHAUSTED/i.test(body)) return "auth";
  return "unavailable";
}

async function queryFreeBusy(
  accessToken: string,
  calendarId: string,
  from: Date,
  to: Date,
  fetchImpl: FetchLike,
): Promise<BusyInterval[]> {
  let response: Response;
  try {
    response = await fetchImpl(FREEBUSY_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        timeZone: "UTC",
        items: [{ id: calendarId }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new ProviderError("unavailable", error instanceof Error ? `Google Calendar: ${error.message}` : "Google Calendar did not answer.");
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new ProviderError(errorKind(response.status, text), `Google Calendar ${response.status}: ${text.slice(0, 200)}`);
  }

  const json = (await response.json()) as FreeBusyResponse;
  const calendars = json.calendars ?? {};
  // Keyed by the id asked for; a lone entry under another key is the same calendar.
  const entries = Object.values(calendars);
  const entry = calendars[calendarId] ?? (entries.length === 1 ? entries[0] : undefined);
  if (!entry) throw new ProviderError("unavailable", "Google Calendar returned no calendar.");
  const reason = entry.errors?.[0]?.reason;
  if (reason) {
    throw new ProviderError(
      reason === "notFound" ? "invalid" : "unavailable",
      reason === "notFound" ? "That calendar could not be found." : `Google Calendar could not read the calendar (${reason}).`,
    );
  }

  return (entry.busy ?? []).flatMap((b) => {
    const start = new Date(b.start ?? "");
    const end = new Date(b.end ?? "");
    return Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start ? [] : [{ start, end }];
  });
}

/** `[from, to)` in pieces Google will answer, in order. */
export function freeBusyWindows(from: Date, to: Date): Array<{ from: Date; to: Date }> {
  const windows: Array<{ from: Date; to: Date }> = [];
  for (let start = from.getTime(); start < to.getTime(); start += FREEBUSY_CHUNK_DAYS * DAY_MS) {
    windows.push({ from: new Date(start), to: new Date(Math.min(start + FREEBUSY_CHUNK_DAYS * DAY_MS, to.getTime())) });
  }
  return windows;
}

/**
 * Busy times on the calendar between two instants. Throws `ProviderError`:
 * `auth` means the grant is gone and the client must reconnect; anything
 * else is a passing failure.
 */
export async function fetchBusyTimes(
  tokens: ProviderTokens,
  config: GoogleBusinessConfig,
  input: { calendarId: string; from: Date; to: Date; now: Date; fetchImpl?: FetchLike },
): Promise<{ busy: BusyInterval[]; update?: TokenUpdate }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const { accessToken, update } = await usableAccessToken(tokens, config, input.now, fetchImpl);
  return { busy: await busyBetween(accessToken, input.calendarId, input.from, input.to, fetchImpl), update };
}

async function busyBetween(
  accessToken: string,
  calendarId: string,
  from: Date,
  to: Date,
  fetchImpl: FetchLike,
): Promise<BusyInterval[]> {
  const pieces = await Promise.all(
    freeBusyWindows(from, to).map((w) => queryFreeBusy(accessToken, calendarId, w.from, w.to, fetchImpl)),
  );
  return pieces.flat().sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * The scheduled look the connections framework runs daily. For a calendar
 * there is nothing to advise on — it is a health check, so a grant that
 * lapsed is found and shown on the Availability page before a customer
 * meets a booking page that cannot check the diary.
 */
export async function checkCalendar(
  tokens: ProviderTokens,
  config: GoogleBusinessConfig,
  context: { now: Date; fetchImpl?: FetchLike },
): Promise<{ audit: Audit; update?: TokenUpdate }> {
  const fetchImpl = context.fetchImpl ?? fetch;
  const from = context.now;
  const to = new Date(context.now.getTime() + CHECK_DAYS * DAY_MS);
  const { accessToken, update } = await usableAccessToken(tokens, config, context.now, fetchImpl);
  let calendarId: string;
  try {
    calendarId = (await fetchIdentity(accessToken, fetchImpl)).email;
  } catch (error) {
    throw new ProviderError("unavailable", error instanceof Error ? error.message : "Google did not say which account this is.");
  }
  const busy = await busyBetween(accessToken, calendarId, from, to, fetchImpl);
  return {
    audit: {
      version: 1,
      at: context.now.toISOString(),
      startAt: from.toISOString(),
      endAt: to.toISOString(),
      headline: `${busy.length} busy time${busy.length === 1 ? "" : "s"} in the next ${CHECK_DAYS} days`,
      rows: [{ label: "Busy in the next week", value: String(busy.length) }],
      findings: [
        {
          severity: "good",
          title: "Busy times are being read",
          detail: "Your website does not offer times that clash with this calendar.",
        },
      ],
      snapshot: { busyCount: busy.length },
    },
    update,
  };
}
