import { and, eq, gt, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { loginAttempts, organizationMemberships, users } from "@/db/schema";
import type { SessionLike } from "@/db/repositories/context";
import { needsRehash, hashPassword, sha256Hex, verifyPassword } from "./password";

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
  | { ok: false; reason: "invalid" | "locked" | "rate_limited" };

/**
 * Authenticate an email and password.
 *
 * Failure reasons are deliberately coarse. The caller must render the same
 * message for `invalid` regardless of whether the account exists, so login
 * cannot be used to enumerate customers.
 */
export async function authenticate(
  db: Database,
  emailRaw: string,
  password: string,
  context: { ipAddress?: string } = {},
): Promise<LoginResult> {
  const email = emailRaw.trim().toLowerCase();
  const emailHash = await sha256Hex(email);
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
    .where(eq(users.email, email))
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
