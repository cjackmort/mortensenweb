import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  loginAttempts,
  organizationMemberships,
  passwordResetTokens,
  users,
} from "@/db/schema";
import type { SessionLike } from "@/db/repositories/context";
import {
  MIN_PASSWORD_LENGTH,
  needsRehash,
  hashPassword,
  sha256Hex,
  verifyPassword,
} from "./password";

/**
 * Session verification and login.
 *
 * The JWT is never trusted on its own. Every authenticated request re-reads the
 * user row and compares `sessionEpoch`, so disabling an account, changing a
 * password, or ending an impersonation invalidates outstanding tokens
 * immediately rather than at token expiry.
 */

/** Rate limiting: attempts allowed per identity within the window. */
export const MAX_ATTEMPTS_PER_ACCOUNT = 5;
export const MAX_ATTEMPTS_PER_IP = 20;
export const ATTEMPT_WINDOW_MINUTES = 15;
export const LOCKOUT_MINUTES = 15;

export interface AuthenticatedUser extends SessionLike {
  email: string;
  name: string | null;
  mustChangePassword: boolean;
}

/**
 * Re-validate a token's claims against the database.
 * Returns null whenever the session should no longer be honoured.
 */
export async function resolveSession(
  db: Database,
  claims: { userId?: string; sessionEpoch?: number } | null | undefined,
): Promise<AuthenticatedUser | null> {
  if (!claims?.userId || typeof claims.sessionEpoch !== "number") return null;

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      status: users.status,
      sessionEpoch: users.sessionEpoch,
      mustChangePassword: users.mustChangePassword,
    })
    .from(users)
    .where(eq(users.id, claims.userId))
    .limit(1);

  const user = rows[0];
  if (!user) return null;
  if (user.status !== "active") return null;
  // The revocation check.
  if (user.sessionEpoch !== claims.sessionEpoch) return null;

  const membership = await db
    .select({ organizationId: organizationMemberships.organizationId })
    .from(organizationMemberships)
    .where(eq(organizationMemberships.userId, user.id))
    .limit(1);

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    sessionEpoch: user.sessionEpoch,
    mustChangePassword: user.mustChangePassword,
    organizationId: membership[0]?.organizationId ?? null,
  };
}

export type LoginResult =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; reason: "invalid" | "locked" | "rate_limited" | "expired" };

/**
 * Authenticate a sign-in identifier and password.
 *
 * The identifier is either the issued handle (`northwind-comfort`) or the
 * email address. Accepting both means the operator can read a short handle
 * down the phone at activation, while the client can still get in months later
 * with the email they actually remember.
 *
 * Failure reasons are deliberately coarse. The caller must render the same
 * message for `invalid` regardless of whether the account exists, so login
 * cannot be used to enumerate customers. `expired` is the one exception: it
 * only ever applies to an already-authenticated temporary credential, so
 * revealing it leaks nothing about which accounts exist.
 */
export async function authenticate(
  db: Database,
  identifierRaw: string,
  password: string,
  context: { ipAddress?: string } = {},
): Promise<LoginResult> {
  const identifier = identifierRaw.trim().toLowerCase();
  // Rate limiting keys off the submitted identifier, so guessing a handle and
  // guessing an email are throttled as the same account.
  const emailHash = await sha256Hex(identifier);
  const ipHash = context.ipAddress ? await sha256Hex(context.ipAddress) : null;

  const windowStart = new Date(Date.now() - ATTEMPT_WINDOW_MINUTES * 60_000);

  const recentByAccount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.emailHash, emailHash),
        eq(loginAttempts.succeeded, false),
        gt(loginAttempts.createdAt, windowStart),
      ),
    );

  if ((recentByAccount[0]?.count ?? 0) >= MAX_ATTEMPTS_PER_ACCOUNT) {
    return { ok: false, reason: "rate_limited" };
  }

  if (ipHash) {
    const recentByIp = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(loginAttempts)
      .where(
        and(
          eq(loginAttempts.ipHash, ipHash),
          eq(loginAttempts.succeeded, false),
          gt(loginAttempts.createdAt, windowStart),
        ),
      );
    if ((recentByIp[0]?.count ?? 0) >= MAX_ATTEMPTS_PER_IP) {
      return { ok: false, reason: "rate_limited" };
    }
  }

  const rows = await db
    .select()
    .from(users)
    .where(or(eq(users.email, identifier), eq(users.username, identifier)))
    .limit(1);
  const user = rows[0];

  const recordAttempt = async (succeeded: boolean) => {
    await db.insert(loginAttempts).values({ emailHash, ipHash, succeeded });
  };

  if (!user) {
    // Still hash, so a missing account is not detectably faster than a wrong
    // password. The comparison result is discarded.
    await verifyPassword(password, null);
    await recordAttempt(false);
    return { ok: false, reason: "invalid" };
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await recordAttempt(false);
    return { ok: false, reason: "locked" };
  }

  const valid = await verifyPassword(password, user.passwordHash);

  if (!valid) {
    const failures = user.failedLoginCount + 1;
    await db
      .update(users)
      .set({
        failedLoginCount: failures,
        lockedUntil:
          failures >= MAX_ATTEMPTS_PER_ACCOUNT
            ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
            : user.lockedUntil,
      })
      .where(eq(users.id, user.id));
    await recordAttempt(false);
    return { ok: false, reason: "invalid" };
  }

  if (user.status !== "active") {
    await recordAttempt(false);
    return { ok: false, reason: "invalid" };
  }

  // Temporary credential lifetime. Checked only after the password verified,
  // so this branch cannot be used to probe which accounts exist.
  if (
    user.mustChangePassword &&
    user.tempPasswordExpiresAt &&
    user.tempPasswordExpiresAt <= new Date()
  ) {
    await recordAttempt(false);
    return { ok: false, reason: "expired" };
  }

  // Transparent upgrade: the plaintext is in hand exactly once, here.
  if (needsRehash(user.passwordHash)) {
    const upgraded = await hashPassword(password);
    await db
      .update(users)
      .set({ passwordHash: upgraded, passwordUpdatedAt: new Date() })
      .where(eq(users.id, user.id));
  }

  await db
    .update(users)
    .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
    .where(eq(users.id, user.id));
  await recordAttempt(true);

  const membership = await db
    .select({ organizationId: organizationMemberships.organizationId })
    .from(organizationMemberships)
    .where(eq(organizationMemberships.userId, user.id))
    .limit(1);

  return {
    ok: true,
    user: {
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
      sessionEpoch: user.sessionEpoch,
      mustChangePassword: user.mustChangePassword,
      organizationId: membership[0]?.organizationId ?? null,
    },
  };
}

/**
 * Password policy.
 *
 * Deliberately a length floor and nothing else. Composition rules ("one
 * capital, one symbol") measurably push people toward `Password1!` and are no
 * longer recommended; length is what actually helps. The floor itself is set in
 * `./password`, where the trade-off it represents is documented.
 *
 * Re-exported from `./password`, never redeclared. That module's `hashPassword`
 * throws below the floor, so a policy check using a *lower* number would accept
 * a password and then crash hashing it.
 */
export { MIN_PASSWORD_LENGTH };
export const MAX_PASSWORD_LENGTH = 200;

export type PasswordRejection =
  | "too_short"
  | "too_long"
  | "not_varied"
  | "same_as_temporary";

export function validateNewPassword(
  candidate: string,
  previous?: string | null,
): PasswordRejection | null {
  if (candidate.length < MIN_PASSWORD_LENGTH) return "too_short";
  if (candidate.length > MAX_PASSWORD_LENGTH) return "too_long";
  if (new Set(candidate).size < 4) return "not_varied";
  if (previous && candidate === previous) return "same_as_temporary";
  return null;
}

export type SetPasswordResult =
  | { ok: true }
  | { ok: false; reason: "invalid_current" | PasswordRejection };

/**
 * Exchange a temporary password for one the client chooses.
 *
 * Advancing `sessionEpoch` here invalidates every outstanding token, including
 * the caller's own. That is intended — the temporary credential was emailed and
 * should stop working everywhere the moment it is replaced. The caller is
 * expected to sign in again immediately with the new password, which it holds
 * at that moment, so the client experiences no interruption.
 */
export async function setOwnPassword(
  db: Database,
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<SetPasswordResult> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const user = rows[0];
  if (!user) return { ok: false, reason: "invalid_current" };

  const valid = await verifyPassword(currentPassword, user.passwordHash);
  if (!valid) return { ok: false, reason: "invalid_current" };

  const rejection = validateNewPassword(newPassword, currentPassword);
  if (rejection) return { ok: false, reason: rejection };

  const now = new Date();
  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(newPassword),
      passwordAlgo: "pbkdf2-sha256",
      passwordUpdatedAt: now,
      mustChangePassword: false,
      tempPasswordExpiresAt: null,
      activatedAt: user.activatedAt ?? now,
      failedLoginCount: 0,
      lockedUntil: null,
      sessionEpoch: sql`${users.sessionEpoch} + 1`,
      updatedAt: now,
    })
    .where(eq(users.id, userId));

  // Any reset link already sitting in an inbox is void now. Without this, a
  // client who changes their password still has a live takeover link in their
  // email for up to an hour.
  await db
    .update(passwordResetTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(passwordResetTokens.userId, userId),
        isNull(passwordResetTokens.usedAt),
      ),
    );

  return { ok: true };
}

/**
 * Revoke every outstanding session for a user by advancing the epoch.
 * Called on password change, account disable, and admin request.
 */
export async function revokeSessions(
  db: Database,
  userId: string,
): Promise<void> {
  await db
    .update(users)
    .set({ sessionEpoch: sql`${users.sessionEpoch} + 1` })
    .where(eq(users.id, userId));
}
