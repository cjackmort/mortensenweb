import { CONNECTION_PROVIDERS as ALL_CONNECTION_PROVIDERS, type ConnectionProvider } from "@/db/schema/connections";
import {
  auditInstagram,
  exchangeInstagramCode,
  fetchInstagramSnapshot,
  instagramAuthorizationUrl,
  instagramConfig,
} from "./providers/instagram";
import {
  auditSearch,
  exchangeGoogleCode,
  fetchSearchSnapshot,
  googleAuthorization,
  googleSearchConfig,
  revokeGoogle,
} from "./providers/google";
import { checkCalendar, exchangeCalendarCode, googleCalendarConfig, CALENDAR_REQUESTED_SCOPES } from "./providers/google-calendar";
import {
  auditStripe,
  deauthorizeStripe,
  exchangeStripeCode,
  fetchStripeSnapshot,
  stripeAuthorizationUrl,
  stripeConnectConfig,
} from "./providers/stripe";
import { connectionTokenKey } from "./seal";
import { auditWindow, type AuditOutcome, type ProviderGrant, type ProviderTokens } from "./types";

/**
 * The providers behind one shape, so the routes, the repository and the page
 * never branch on which one they hold.
 *
 * Each is "available" only when its keys are set. The page still shows the
 * card for an unavailable one — what it would look at, and that it is not
 * switched on yet — because a client asking for it is how the operator
 * learns it is wanted.
 */

export type { ConnectionProvider };

/**
 * The accounts on the Connections page and in the monthly report: the ones
 * the portal audits and advises on. Google Calendar is not among them — it is
 * connected from Availability, for busy times, and has nothing to report —
 * but it is a provider all the same, so the start and callback routes, the
 * daily check and disconnecting work for it unchanged.
 */
export const CONNECTION_PROVIDERS = ["stripe", "google", "instagram"] as const satisfies readonly ConnectionProvider[];

export function isConnectionProvider(value: unknown): value is ConnectionProvider {
  return typeof value === "string" && (ALL_CONNECTION_PROVIDERS as readonly string[]).includes(value);
}

export interface AuditContext {
  siteHost: string | null;
  now: Date;
  /** Injected by tests; the real one is global fetch. */
  fetchImpl?: typeof fetch;
}

export interface ProviderAdapter {
  key: ConnectionProvider;
  name: string;
  /** What the client is connecting, in their words. */
  what: string;
  /** What the audit looks at, one line each. */
  looksAt: string[];
  /** What it never does, said plainly: the question a careful client asks. */
  never: string;
  /** Set up on this server? Missing names the env vars, for the operator. */
  configured(): { ok: true } | { ok: false; missing: string[] };
  /** Where to send the client; PKCE verifier where the provider uses one. */
  begin(input: { state: string }): Promise<{ url: string; codeVerifier: string }>;
  complete(input: { code: string; codeVerifier: string }): Promise<ProviderGrant>;
  audit(tokens: ProviderTokens, context: AuditContext): Promise<AuditOutcome>;
  /** Tell the provider the access is over. Best effort; the row is revoked either way. */
  revoke(tokens: ProviderTokens): Promise<void>;
  /** The page the client connects it from, and returns to. The Connections page when unset. */
  home?: string;
}

export const CONNECTIONS_HOME = "/dashboard/connections";

/** Where a provider's connect flow sends the client back to. */
export function connectionHome(provider: ConnectionProvider): string {
  return PROVIDERS[provider].home ?? CONNECTIONS_HOME;
}

/** The key every token needs, checked alongside each provider's own keys. */
function sealKeyMissing(): string[] {
  return connectionTokenKey() ? [] : ["CONNECTION_TOKEN_KEY"];
}

const stripe: ProviderAdapter = {
  key: "stripe",
  name: "Stripe",
  what: "the Stripe account your customers pay into",
  looksAt: [
    "What was taken, refunded and disputed in the last 30 days",
    "How many payment attempts failed",
    "Whether payouts are on and Stripe is waiting on anything",
    "What customers see on their statement and receipts",
  ],
  never: "Read-only. We cannot move money, refund, or change anything in your Stripe account.",
  configured() {
    const check = stripeConnectConfig();
    return check.ok ? { ok: true } : { ok: false, missing: check.missing };
  },
  async begin({ state }) {
    const check = stripeConnectConfig();
    if (!check.ok) throw new Error("Stripe Connect is not configured.");
    return {
      url: stripeAuthorizationUrl({ clientId: check.clientId, redirectUri: callbackUrl("stripe"), state }),
      codeVerifier: "",
    };
  },
  complete({ code }) {
    return exchangeStripeCode(code);
  },
  async audit(tokens, context) {
    const window = auditWindow(context.now);
    const snapshot = await fetchStripeSnapshot(tokens.externalId, window);
    return { audit: auditStripe(snapshot, { ...window, siteHost: context.siteHost, now: context.now }) };
  },
  async revoke(tokens) {
    const check = stripeConnectConfig();
    if (check.ok) await deauthorizeStripe(tokens.externalId, check.clientId);
  },
};

const google: ProviderAdapter = {
  key: "google",
  name: "Google Search Console",
  what: "the Google account that owns your site in Search Console",
  looksAt: [
    "What people searched to find you, and how often you were shown",
    "How often they clicked, and where you ranked",
    "Searches you are close to the top for",
    "Pages that are seen but not clicked",
  ],
  never: "Read-only, Search Console only. We do not ask for your email, calendar or Google Business Profile.",
  configured() {
    const check = googleSearchConfig();
    const missing = [...(check.ok ? [] : check.missing), ...sealKeyMissing()];
    return missing.length === 0 ? { ok: true } : { ok: false, missing: [...new Set(missing)] };
  },
  async begin({ state }) {
    const check = googleSearchConfig();
    if (!check.ok) throw new Error("Google is not configured.");
    return googleAuthorization(check.config, state);
  },
  complete({ code, codeVerifier }) {
    const check = googleSearchConfig();
    if (!check.ok) throw new Error("Google is not configured.");
    return exchangeGoogleCode(check.config, code, codeVerifier);
  },
  async audit(tokens, context) {
    const check = googleSearchConfig();
    if (!check.ok) throw new Error("Google is not configured.");
    const window = auditWindow(context.now);
    const { snapshot, update } = await fetchSearchSnapshot(tokens, check.config, context);
    return {
      audit: auditSearch(snapshot, { ...window, siteHost: context.siteHost, now: context.now }),
      tokens: update,
    };
  },
  revoke(tokens) {
    return revokeGoogle(tokens);
  },
};

const instagram: ProviderAdapter = {
  key: "instagram",
  name: "Instagram",
  what: "your Instagram business or creator account",
  looksAt: [
    "How often you post, and when you last did",
    "Whether the bio sends people to your site",
    "How many followers respond to a post",
    "Whether there is any video among recent posts",
  ],
  never: "Read-only. We cannot post, message, follow or change your profile.",
  configured() {
    const check = instagramConfig();
    const missing = [...(check.ok ? [] : check.missing), ...sealKeyMissing()];
    return missing.length === 0 ? { ok: true } : { ok: false, missing: [...new Set(missing)] };
  },
  async begin({ state }) {
    const check = instagramConfig();
    if (!check.ok) throw new Error("Instagram is not configured.");
    return { url: instagramAuthorizationUrl(check.config, state), codeVerifier: "" };
  },
  complete({ code }) {
    const check = instagramConfig();
    if (!check.ok) throw new Error("Instagram is not configured.");
    return exchangeInstagramCode(check.config, code);
  },
  async audit(tokens, context) {
    const window = auditWindow(context.now);
    const { snapshot, update } = await fetchInstagramSnapshot(tokens, context);
    return {
      audit: auditInstagram(snapshot, { ...window, siteHost: context.siteHost, now: context.now }),
      tokens: update,
    };
  },
  async revoke() {
    // Instagram has no revoke endpoint for this flow; the client removes the
    // app under Instagram's "Apps and websites" if they want the grant gone.
  },
};

const googleCalendar: ProviderAdapter = {
  key: "google_calendar",
  name: "Google Calendar",
  what: "the Google Calendar you keep your appointments in",
  looksAt: ["When you are busy, so your website does not offer those times"],
  never:
    "Busy or free only. We cannot see what your events are, who is in them or where, and we cannot add, change or delete anything in your calendar.",
  home: "/dashboard/availability",
  configured() {
    const check = googleCalendarConfig();
    const missing = [...(check.ok ? [] : check.missing), ...sealKeyMissing()];
    return missing.length === 0 ? { ok: true } : { ok: false, missing: [...new Set(missing)] };
  },
  async begin({ state }) {
    const check = googleCalendarConfig();
    if (!check.ok) throw new Error("Google Calendar is not configured.");
    return googleAuthorization(check.config, state, CALENDAR_REQUESTED_SCOPES);
  },
  complete({ code, codeVerifier }) {
    const check = googleCalendarConfig();
    if (!check.ok) throw new Error("Google Calendar is not configured.");
    return exchangeCalendarCode(check.config, code, codeVerifier);
  },
  async audit(tokens, context) {
    const check = googleCalendarConfig();
    if (!check.ok) throw new Error("Google Calendar is not configured.");
    const { audit, update } = await checkCalendar(tokens, check.config, context);
    return { audit, tokens: update };
  },
  revoke(tokens) {
    // Google ends every grant this OAuth client holds for the account when
    // any one of its tokens is revoked — Search Console's too, if the client
    // connected it with the same Google account. Disconnecting from
    // Availability checks for that and skips this call when it would.
    return revokeGoogle(tokens);
  },
};

export const PROVIDERS: Record<ConnectionProvider, ProviderAdapter> = {
  stripe,
  google,
  instagram,
  google_calendar: googleCalendar,
};

export function providerAdapter(provider: ConnectionProvider): ProviderAdapter {
  return PROVIDERS[provider];
}

/** Where a provider sends the client back. Must be registered with the provider exactly. */
export function callbackUrl(provider: ConnectionProvider): string {
  const base = (process.env.AUTH_URL ?? "").trim().replace(/\/$/, "");
  return `${base}/api/connections/${provider}/callback`;
}
