import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, passwordResetTokens, users } from "@/db/schema";
import { hashPassword, newSecureToken, sha256Hex } from "./password";
import { validateNewPassword, type PasswordRejection } from "./session";

/**
 * Self-service password reset.
 *
 * The link emailed to the client is a bearer credential: whoever holds it can
 * take the account. Every property here follows from that one fact.
 *
 *  - 256 bits of CSPRNG output, so it cannot be guessed.
 *  - Only the SHA-256 digest is stored, so a database disclosure does not yield
 *    a working link.
 *  - One hour to live, because it sits in an inbox.
 *  - Single use, claimed atomically, so a forwarded email cannot be replayed.
 *  - Redeeming it advances `sessionEpoch`, which terminates every session the
 *    account already had. If the reset was triggered by someone who had stolen
 *    a session, that session dies here.
 *
 * The request side never reveals whether an account exists. `requestPasswordReset`
 * returns null for an unknown identifier, a disabled account, and a rate-limited
 * caller alike, and the page renders the same confirmation in all four cases.
 */

/** Short, because the link lives in an inbox. */
export const RESET_TOKEN_TTL_MINUTES = 60;

/** Throttling, so the endpoint cannot be used to flood a client's mailbox. */
export const MAX_RESET_REQUESTS_PER_ACCOUNT = 3;
export const MAX_RESET_REQUESTS_PER_IP = 10;
export const RESET_REQUEST_WINDOW_MINUTES = 60;

export interface ResetGrant {
  /** Plaintext token. Returned once, emailed, never stored or logged. */
  token: string;
  userId: string;
  email: string;
  name: string | null;
  expiresAt: Date;
}

/**
 * Issue a reset token for an identifier — the handle or the email address.
 *
 * Returns null whenever no email should be sent. The caller MUST render the
 * same confirmation regardless, or this becomes an account enumeration oracle.
 */
export async function requestPasswordReset(
  db: Database,
  identifierRaw: string,
  context: { ipAddress?: string } = {},
): Promise<ResetGrant | null> {
  const identifier = identifierRaw.trim().toLowerCase();
  if (!identifier) return null;

  const ipHash = context.ipAddress ? await sha256Hex(context.ipAddress) : null;
  const windowStart = new Date(
    Date.now() - RESET_REQUEST_WINDOW_MINUTES * 60_000,
  );

  // IP throttle first: it does not depend on the account existing, so checking
  // it before the user lookup keeps the cheap path cheap for an abuser.
  if (ipHash) {
    const recentByIp = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.requestedIpHash, ipHash),
          gt(passwordResetTokens.createdAt, windowStart),
        ),
      );
    if ((recentByIp[0]?.count ?? 0) >= MAX_RESET_REQUESTS_PER_IP) return null;
  }

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      status: users.status,
    })
    .from(users)
    .where(or(eq(users.email, identifier), eq(users.username, identifier)))
    .limit(1);

  const user = rows[0];
  if (!user) return null;
  // A disabled account is not a password problem, and mailing it would confirm
  // the address exists.
  if (user.status !== "active") return null;

  const recentByAccount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.userId, user.id),
        gt(passwordResetTokens.createdAt, windowStart),
      ),
    );
  if ((recentByAccount[0]?.count ?? 0) >= MAX_RESET_REQUESTS_PER_ACCOUNT) {
    return null;
  }

  const now = new Date();

  // Supersede outstanding links: requesting a new one should invalidate the
  // old, so a link in an older email cannot be used later.
  await db
    .update(passwordResetTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(passwordResetTokens.userId, user.id),
        isNull(passwordResetTokens.usedAt),
      ),
    );

  const token = newSecureToken();
  const expiresAt = new Date(now.getTime() + RESET_TOKEN_TTL_MINUTES * 60_000);

  await db.insert(passwordResetTokens).values({
    userId: user.id,
    tokenHash: await sha256Hex(token),
    expiresAt,
    requestedIpHash: ipHash,
  });

  // Records that a reset was requested, never the token itself.
  await db.insert(auditLog).values({
    actorUserId: user.id,
    action: "user.password_reset_requested",
    entityType: "user",
    entityId: user.id,
    ipHash,
    metadata: { expiresAt: expiresAt.toISOString() },
  });

  return {
    token,
    userId: user.id,
    email: user.email,
    name: user.name,
    expiresAt,
  };
}

export type ResetRedemption =
  | { ok: true; userId: string; email: string }
  | { ok: false; reason: "invalid" | "expired" | "used" | PasswordRejection };

/**
 * Check a token without consuming it, so the reset form can refuse to render
 * against a dead link instead of collecting a password and then failing.
 */
export async function inspectResetToken(
  db: Database,
  token: string,
): Promise<{ ok: true } | { ok: false; reason: "invalid" | "expired" | "used" }> {
  if (!token) return { ok: false, reason: "invalid" };

  const rows = await db
    .select({
      usedAt: passwordResetTokens.usedAt,
      expiresAt: passwordResetTokens.expiresAt,
    })
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.tokenHash, await sha256Hex(token)))
    .limit(1);

  const row = rows[0];
  if (!row) return { ok: false, reason: "invalid" };
  if (row.usedAt) return { ok: false, reason: "used" };
  if (row.expiresAt <= new Date()) return { ok: false, reason: "expired" };
  return { ok: true };
}

/**
 * Redeem a token and set the new password.
 *
 * Order matters. The password is validated *before* the token is claimed, so a
 * password that is too short does not burn the link and strand the client. The
 * claim is then a conditional update, which is what makes double submission and
 * two concurrent tabs safe: exactly one of them updates a row.
 */
export async function redeemPasswordReset(
  db: Database,
  token: string,
  newPassword: string,
): Promise<ResetRedemption> {
  if (!token) return { ok: false, reason: "invalid" };

  const tokenHash = await sha256Hex(token);

  const rows = await db
    .select({
      id: passwordResetTokens.id,
      userId: passwordResetTokens.userId,
      usedAt: passwordResetTokens.usedAt,
      expiresAt: passwordResetTokens.expiresAt,
    })
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.tokenHash, tokenHash))
    .limit(1);

  const row = rows[0];
  if (!row) return { ok: false, reason: "invalid" };
  if (row.usedAt) return { ok: false, reason: "used" };
  if (row.expiresAt <= new Date()) return { ok: false, reason: "expired" };

  const rejection = validateNewPassword(newPassword);
  if (rejection) return { ok: false, reason: rejection };

  const userRows = await db
    .select({
      id: users.id,
      email: users.email,
      status: users.status,
      activatedAt: users.activatedAt,
    })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);

  const user = userRows[0];
  // Disabled between issuing and redeeming: the link is dead, and saying why
  // would confirm the account exists.
  if (!user || user.status !== "active") return { ok: false, reason: "invalid" };

  const now = new Date();

  // Atomic claim. A second concurrent redemption matches zero rows.
  const claimed = await db
    .update(passwordResetTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(passwordResetTokens.id, row.id),
        isNull(passwordResetTokens.usedAt),
      ),
    )
    .returning({ id: passwordResetTokens.id });

  if (claimed.length === 0) return { ok: false, reason: "used" };

  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(newPassword),
      passwordAlgo: "pbkdf2-sha256",
      passwordUpdatedAt: now,
      // A reset produces a real password, so the temporary-credential state is
      // cleared outright rather than sending them to /change-password again.
      mustChangePassword: false,
      tempPasswordExpiresAt: null,
      activatedAt: user.activatedAt ?? now,
      // Whoever locked the account out is why they are here.
      failedLoginCount: 0,
      lockedUntil: null,
      // Terminates every existing session, including an attacker's.
      sessionEpoch: sql`${users.sessionEpoch} + 1`,
      updatedAt: now,
    })
    .where(eq(users.id, user.id));

  // Any other link that was outstanding is now void.
  await db
    .update(passwordResetTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(passwordResetTokens.userId, user.id),
        isNull(passwordResetTokens.usedAt),
      ),
    );

  await db.insert(auditLog).values({
    actorUserId: user.id,
    action: "user.password_reset_completed",
    entityType: "user",
    entityId: user.id,
  });

  return { ok: true, userId: user.id, email: user.email };
}

/**
 * The canonical origin of the portal.
 *
 * Read from configuration and never from the request's Host header. A reset
 * link built from an attacker-supplied Host is the classic host-header
 * poisoning route to account takeover: the victim receives a real token
 * pointing at the attacker's domain.
 */
export function portalOrigin(): string {
  const configured = process.env.AUTH_URL ?? process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) return configured.replace(/\/$/, "");
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "AUTH_URL must be set in production: password reset links cannot be built safely without it.",
    );
  }
  return "http://localhost:3000";
}

export function resetLink(token: string): string {
  return `${portalOrigin()}/reset-password?token=${encodeURIComponent(token)}`;
}
