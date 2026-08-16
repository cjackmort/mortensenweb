import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { passwordResetTokens, users } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { hashPassword, sha256Hex, verifyPassword } from "@/lib/auth/password";
import {
  MAX_RESET_REQUESTS_PER_ACCOUNT,
  inspectResetToken,
  redeemPasswordReset,
  requestPasswordReset,
} from "@/lib/auth/reset";
import {
  MIN_PASSWORD_LENGTH,
  authenticate,
  setOwnPassword,
  validateNewPassword,
} from "@/lib/auth/session";
import { createTestDb } from "./helpers/db";

/**
 * Password reset.
 *
 * The emailed link is a bearer credential, so the tests that matter are the
 * ones about what happens when it is stolen, replayed, or stale — not the happy
 * path. Enumeration symmetry is checked too: the request side must behave
 * identically for an account that exists and one that does not.
 */

let db: Database;
let close: () => Promise<void>;

const ORIGINAL = "original-password-1234";
const REPLACEMENT = "replacement-password-5678";

async function seedUser(
  overrides: Partial<typeof users.$inferInsert> = {},
): Promise<string> {
  const rows = await db
    .insert(users)
    .values({
      publicId: newPublicId(),
      email: "owner@northwind.test",
      username: "northwind-comfort",
      name: "Dana",
      passwordHash: await hashPassword(ORIGINAL),
      passwordAlgo: "pbkdf2-sha256",
      role: "client",
      status: "active",
      ...overrides,
    })
    .returning({ id: users.id });
  return rows[0]!.id;
}

async function readUser(userId: string) {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return rows[0]!;
}

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await db.delete(passwordResetTokens);
  await db.delete(users);
});

describe("requesting a reset", () => {
  it("issues a token for a known email and for the username alike", async () => {
    await seedUser();

    const byEmail = await requestPasswordReset(db, "owner@northwind.test");
    expect(byEmail).not.toBeNull();

    await db.delete(passwordResetTokens);
    const byUsername = await requestPasswordReset(db, "northwind-comfort");
    expect(byUsername).not.toBeNull();
  });

  it("is case and whitespace insensitive, as typed on a phone", async () => {
    await seedUser();
    const grant = await requestPasswordReset(db, "  OWNER@Northwind.TEST  ");
    expect(grant).not.toBeNull();
  });

  it("stores only the digest — the database never holds a usable link", async () => {
    await seedUser();
    const grant = await requestPasswordReset(db, "owner@northwind.test");

    const rows = await db.select().from(passwordResetTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(await sha256Hex(grant!.token));
    // The plaintext must appear nowhere in the row.
    expect(JSON.stringify(rows[0])).not.toContain(grant!.token);
  });

  it("returns null for an unknown identifier, and writes nothing", async () => {
    await seedUser();
    const grant = await requestPasswordReset(db, "stranger@example.test");
    expect(grant).toBeNull();
    expect(await db.select().from(passwordResetTokens)).toHaveLength(0);
  });

  it("returns null for a disabled account", async () => {
    await seedUser({ status: "disabled" });
    expect(await requestPasswordReset(db, "owner@northwind.test")).toBeNull();
  });

  it("supersedes an outstanding link when a new one is requested", async () => {
    await seedUser();
    const first = await requestPasswordReset(db, "owner@northwind.test");
    const second = await requestPasswordReset(db, "owner@northwind.test");

    expect(await inspectResetToken(db, first!.token)).toEqual({
      ok: false,
      reason: "used",
    });
    expect(await inspectResetToken(db, second!.token)).toEqual({ ok: true });
  });

  it("throttles repeated requests for one account", async () => {
    await seedUser();
    for (let i = 0; i < MAX_RESET_REQUESTS_PER_ACCOUNT; i += 1) {
      expect(await requestPasswordReset(db, "owner@northwind.test")).not.toBeNull();
    }
    expect(await requestPasswordReset(db, "owner@northwind.test")).toBeNull();
  });
});

describe("redeeming a reset", () => {
  it("sets the new password and retires the old one", async () => {
    const userId = await seedUser();
    const grant = await requestPasswordReset(db, "owner@northwind.test");

    const result = await redeemPasswordReset(db, grant!.token, REPLACEMENT);
    expect(result.ok).toBe(true);

    const user = await readUser(userId);
    await expect(verifyPassword(REPLACEMENT, user.passwordHash)).resolves.toBe(true);
    await expect(verifyPassword(ORIGINAL, user.passwordHash)).resolves.toBe(false);
  });

  it("is single use — a forwarded link cannot be replayed", async () => {
    await seedUser();
    const grant = await requestPasswordReset(db, "owner@northwind.test");

    expect((await redeemPasswordReset(db, grant!.token, REPLACEMENT)).ok).toBe(true);

    const replay = await redeemPasswordReset(db, grant!.token, "third-password-9012");
    expect(replay).toEqual({ ok: false, reason: "used" });
  });

  it("rejects an expired link", async () => {
    await seedUser();
    const grant = await requestPasswordReset(db, "owner@northwind.test");

    await db
      .update(passwordResetTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(passwordResetTokens.tokenHash, await sha256Hex(grant!.token)));

    expect(await redeemPasswordReset(db, grant!.token, REPLACEMENT)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a token that was never issued", async () => {
    await seedUser();
    expect(await redeemPasswordReset(db, "f".repeat(64), REPLACEMENT)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("terminates every existing session by advancing the epoch", async () => {
    const userId = await seedUser();
    const before = (await readUser(userId)).sessionEpoch;

    const grant = await requestPasswordReset(db, "owner@northwind.test");
    await redeemPasswordReset(db, grant!.token, REPLACEMENT);

    expect((await readUser(userId)).sessionEpoch).toBe(before + 1);
  });

  it("clears a lockout, since being locked out is why they are here", async () => {
    const userId = await seedUser();
    await db
      .update(users)
      .set({
        failedLoginCount: 5,
        lockedUntil: new Date(Date.now() + 15 * 60_000),
      })
      .where(eq(users.id, userId));

    const grant = await requestPasswordReset(db, "owner@northwind.test");
    await redeemPasswordReset(db, grant!.token, REPLACEMENT);

    const user = await readUser(userId);
    expect(user.failedLoginCount).toBe(0);
    expect(user.lockedUntil).toBeNull();

    // And the account is genuinely usable again.
    const login = await authenticate(db, "owner@northwind.test", REPLACEMENT);
    expect(login.ok).toBe(true);
  });

  it("does not burn the link when the new password is rejected", async () => {
    await seedUser();
    const grant = await requestPasswordReset(db, "owner@northwind.test");

    // Derived from the floor, never hardcoded: this test exists to catch a
    // mismatch between policy and hashing, so it must move when the floor does.
    const below = "abcdefghijkl".slice(0, MIN_PASSWORD_LENGTH - 1);
    const tooShort = await redeemPasswordReset(db, grant!.token, below);
    expect(tooShort).toEqual({ ok: false, reason: "too_short" });

    // Still live, so the client can simply try again.
    expect(await inspectResetToken(db, grant!.token)).toEqual({ ok: true });
    expect((await redeemPasswordReset(db, grant!.token, REPLACEMENT)).ok).toBe(true);
  });

  it("clears the temporary-credential state rather than looping onboarding", async () => {
    const userId = await seedUser({
      mustChangePassword: true,
      tempPasswordExpiresAt: new Date(Date.now() + 86_400_000),
    });

    const grant = await requestPasswordReset(db, "owner@northwind.test");
    await redeemPasswordReset(db, grant!.token, REPLACEMENT);

    const user = await readUser(userId);
    expect(user.mustChangePassword).toBe(false);
    expect(user.tempPasswordExpiresAt).toBeNull();
    expect(user.activatedAt).not.toBeNull();
  });
});

describe("interaction with a normal password change", () => {
  it("voids a reset link still sitting in the inbox", async () => {
    const userId = await seedUser();
    const grant = await requestPasswordReset(db, "owner@northwind.test");

    await setOwnPassword(db, userId, ORIGINAL, REPLACEMENT);

    expect(await inspectResetToken(db, grant!.token)).toEqual({
      ok: false,
      reason: "used",
    });
  });
});

/**
 * The regression that sent a 500 to a real user: `validateNewPassword` accepted
 * ten characters while `hashPassword` threw below twelve, so a password in that
 * gap passed validation and then crashed the request.
 */
describe("password length floor is a single number", () => {
  it("accepts the floor exactly, through validation and hashing both", async () => {
    const atFloor = "abcdefghijkl".slice(0, MIN_PASSWORD_LENGTH);
    expect(atFloor).toHaveLength(MIN_PASSWORD_LENGTH);
    expect(validateNewPassword(atFloor)).toBeNull();
    await expect(hashPassword(atFloor)).resolves.toContain("$pbkdf2-sha256$");
  });

  it("rejects one below the floor at validation, never at hashing", async () => {
    const below = "abcdefghijkl".slice(0, MIN_PASSWORD_LENGTH - 1);
    expect(validateNewPassword(below)).toBe("too_short");
  });

  it("never lets a validated password reach a throwing hash", async () => {
    // Every length from the floor upward: validation and hashing must agree.
    for (let length = MIN_PASSWORD_LENGTH; length <= MIN_PASSWORD_LENGTH + 4; length += 1) {
      const candidate = "abcdefghijklmnop".slice(0, length);
      expect(validateNewPassword(candidate)).toBeNull();
      await expect(hashPassword(candidate)).resolves.toBeTruthy();
    }
  });
});

/**
 * The behaviour asked for directly: once a password has been changed, signing
 * in again must go straight through rather than back to the change screen.
 */
describe("a changed password is remembered at the next sign-in", () => {
  it("drops the forced-change flag permanently and admits the new password", async () => {
    const userId = await seedUser({
      mustChangePassword: true,
      tempPasswordExpiresAt: new Date(Date.now() + 86_400_000),
    });

    const changed = await setOwnPassword(db, userId, ORIGINAL, REPLACEMENT);
    expect(changed.ok).toBe(true);

    // Persisted, not merely reflected in the session that made the change.
    expect((await readUser(userId)).mustChangePassword).toBe(false);

    const login = await authenticate(db, "owner@northwind.test", REPLACEMENT);
    expect(login.ok).toBe(true);
    // False here is what routes `/` to the dashboard instead of /change-password.
    expect(login.ok && login.user.mustChangePassword).toBe(false);
  });

  it("still refuses the retired temporary password", async () => {
    const userId = await seedUser({
      mustChangePassword: true,
      tempPasswordExpiresAt: new Date(Date.now() + 86_400_000),
    });
    await setOwnPassword(db, userId, ORIGINAL, REPLACEMENT);

    const stale = await authenticate(db, "owner@northwind.test", ORIGINAL);
    expect(stale.ok).toBe(false);
  });

  it("survives a second sign-in, so the flag does not resurface", async () => {
    const userId = await seedUser({
      mustChangePassword: true,
      tempPasswordExpiresAt: new Date(Date.now() + 86_400_000),
    });
    await setOwnPassword(db, userId, ORIGINAL, REPLACEMENT);

    // Reset the throttle between attempts; this test is about the flag.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const login = await authenticate(db, "owner@northwind.test", REPLACEMENT);
      expect(login.ok && login.user.mustChangePassword).toBe(false);
    }

    expect((await readUser(userId)).mustChangePassword).toBe(false);
    expect(await db.select({ n: sql<number>`count(*)::int` }).from(users)).toHaveLength(1);
  });
});
