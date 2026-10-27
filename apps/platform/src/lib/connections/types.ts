import { z } from "zod";
import type { ConnectionProvider } from "@/db/schema/connections";

/**
 * What every provider has in common, so the repository, the page and the
 * report never need to know which one they are holding.
 */

export type { ConnectionProvider };

/** What a provider hands back once the client has said yes at its consent screen. */
export interface ProviderGrant {
  externalId: string;
  displayName: string | null;
  scope: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
}

/** The tokens as the audit needs them, opened from the row. */
export interface ProviderTokens {
  externalId: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
}

export type FindingSeverity = "fix" | "improve" | "good";

export const findingSchema = z.object({
  severity: z.enum(["fix", "improve", "good"]),
  /** One line, the thing itself: "Stripe needs information from you". */
  title: z.string().min(1),
  /** One or two sentences: what was seen and what to do about it. */
  detail: z.string().min(1),
});

export type Finding = z.infer<typeof findingSchema>;

export const AUDIT_VERSION = 1;

/**
 * What a look at an account produces and what is stored. `rows` are the
 * figures the report shows; `findings` are what to do about them; `snapshot`
 * is the raw material, kept so a finding can be checked against it later.
 */
export const auditSchema = z.object({
  version: z.literal(AUDIT_VERSION),
  at: z.string(),
  /** The 30 days the figures cover, ISO. */
  startAt: z.string(),
  endAt: z.string(),
  headline: z.string(),
  rows: z.array(z.object({ label: z.string(), value: z.string() })),
  findings: z.array(findingSchema),
  snapshot: z.record(z.string(), z.unknown()),
});

export type Audit = z.infer<typeof auditSchema>;

export function parseAudit(raw: unknown): Audit | null {
  const parsed = auditSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The figures look at the last 30 days: long enough to mean something, short enough to act on. */
export const AUDIT_WINDOW_DAYS = 30;

export function auditWindow(now: Date): { startAt: Date; endAt: Date } {
  return { startAt: new Date(now.getTime() - AUDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000), endAt: now };
}

/** Refreshed tokens, when a provider issued new ones during the audit, for the row to keep. */
export interface TokenUpdate {
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: Date | null;
}

export interface AuditOutcome {
  audit: Audit;
  tokens?: TokenUpdate;
}

export class ProviderError extends Error {
  readonly kind: "auth" | "unavailable" | "invalid";
  constructor(kind: "auth" | "unavailable" | "invalid", message: string) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
  }
}

/** The site's host name, for checks like "does the bio link to the website". */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

export function percent(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(
    cents / 100,
  );
}
