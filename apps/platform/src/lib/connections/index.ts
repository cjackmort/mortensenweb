import { CONNECTION_PROVIDERS, type ConnectionProvider } from "@/db/schema/connections";
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
import { acceptStripeKey, auditStripe, checkStripeKey, fetchStripeSnapshot, stripeForKey } from "./providers/stripe";
import { connectionTokenKey } from "./seal";
import { auditWindow, ProviderError, type AuditOutcome, type ProviderGrant, type ProviderTokens } from "./types";

/**
 * The three providers behind one shape, so the repository and the report
 * never branch on which one they hold. Only how a client connects differs:
 * Google and Instagram send them to a consent screen (`oauth`), Stripe asks
 * for a restricted key they make themselves (`key`).
 *
 * Each is "available" only when its keys are set. The page still shows the
 * card for an unavailable one — what it would look at, and that it is not
 * switched on yet — because a client asking for it is how the operator
 * learns it is wanted.
 */

export { CONNECTION_PROVIDERS, type ConnectionProvider };

export function isConnectionProvider(value: unknown): value is ConnectionProvider {
  return typeof value === "string" && (CONNECTION_PROVIDERS as readonly string[]).includes(value);
}

export interface AuditContext {
  siteHost: string | null;
  now: Date;
  /** Injected by tests; the real one is global fetch. */
  fetchImpl?: typeof fetch;
}

interface AdapterBase {
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
  audit(tokens: ProviderTokens, context: AuditContext): Promise<AuditOutcome>;
  /** Tell the provider the access is over. Best effort; the row is revoked either way. */
  revoke(tokens: ProviderTokens): Promise<void>;
}

export interface OAuthAdapter extends AdapterBase {
  connectWith: "oauth";
  /** Where to send the client; PKCE verifier where the provider uses one. */
  begin(input: { state: string }): Promise<{ url: string; codeVerifier: string }>;
  complete(input: { code: string; codeVerifier: string }): Promise<ProviderGrant>;
}

export interface KeyAdapter extends AdapterBase {
  connectWith: "key";
  /**
   * Check a pasted key and read with it once. A `ProviderError` of kind
   * `invalid` carries a message meant for the client; it never contains the key.
   */
  acceptKey(raw: string): Promise<ProviderGrant>;
  /** What the client should do at the provider once disconnected, since we cannot do it for them. */
  afterDisconnect: string;
}

export type ProviderAdapter = OAuthAdapter | KeyAdapter;

/** The key every token needs, checked alongside each provider's own keys. */
function sealKeyMissing(): string[] {
  return connectionTokenKey() ? [] : ["CONNECTION_TOKEN_KEY"];
}

const stripe: KeyAdapter = {
  key: "stripe",
  connectWith: "key",
  name: "Stripe",
  what: "the Stripe account your customers pay into",
  looksAt: [
    "What was taken, refunded and disputed in the last 30 days",
    "How many payment attempts failed",
    "Whether payouts are on and Stripe is waiting on anything",
    "What customers see on their statement and receipts",
  ],
  never: "Read-only: the key you make for us can only read. We cannot move money, refund, or change anything in your Stripe account.",
  afterDisconnect: "Delete the MortensenWeb key in Stripe under Developers, API keys, as well.",
  configured() {
    const missing = sealKeyMissing();
    return missing.length === 0 ? { ok: true } : { ok: false, missing };
  },
  async acceptKey(raw) {
    const check = checkStripeKey(raw);
    if (!check.ok) throw new ProviderError("invalid", check.message);
    return acceptStripeKey(check.key);
  },
  async audit(tokens, context) {
    if (!tokens.accessToken) throw new ProviderError("auth", "No Stripe key is kept for this account. Connect it again.");
    const window = auditWindow(context.now);
    const snapshot = await fetchStripeSnapshot(window, { stripe: stripeForKey(tokens.accessToken) });
    return { audit: auditStripe(snapshot, { ...window, siteHost: context.siteHost, now: context.now }) };
  },
  async revoke() {
    // Nothing to call: a restricted key can only be deleted in the client's
    // own dashboard. Clearing the sealed copy ends our access; the page tells
    // the client to delete the key too.
  },
};

const google: OAuthAdapter = {
  key: "google",
  connectWith: "oauth",
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

const instagram: OAuthAdapter = {
  key: "instagram",
  connectWith: "oauth",
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

export const PROVIDERS: Record<ConnectionProvider, ProviderAdapter> = { stripe, google, instagram };

export function providerAdapter(provider: ConnectionProvider): ProviderAdapter {
  return PROVIDERS[provider];
}
