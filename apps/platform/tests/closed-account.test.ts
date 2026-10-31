import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  auditLog,
  clients,
  organizationMemberships,
  organizations,
  passwordResetTokens,
  users,
} from "@/db/schema";
import { adminContextFrom, type AdminContext } from "@/db/repositories/context";
import { archiveClient, restoreClient } from "@/db/repositories/admin/clients";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import {
  inspectResetToken,
  redeemPasswordReset,
  requestPasswordReset,
} from "@/lib/auth/reset";
import { authenticate, resolveSession } from "@/lib/auth/session";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * A removed (archived) client can no longer sign in.
 *
 * Removing a client takes them off the Clients list; closing their sign-in is
 * the other half, so a client the operator has let go cannot keep using the
 * portal. It is read off `clients.archived_at` — nothing is written to the
 * users' rows — so Restore re-enables everyone exactly as they were, including
 * a user who was disabled beforehand staying disabled.
 *
 * Three doors have to agree, or one of them is a back way in:
 *  - credentials sign-in (`authenticate`),
 *  - every request a signed-in session makes (`resolveSession`, the only thing
 *    the JWT is checked against),
 *  - password reset, which ends in a sign-in.
 * Admins are never affected: they hold no client record to archive.
 */

let db: Database;
let close: () => Promise<void>;
let ctx: AdminContext;

const PASSWORD = "client-password-1234";
const ADMIN_PASSWORD = "admin-password-5678";

async function seedClientUser(name = "Northwind") {
  const org = (
    await db
      .insert(organizations)
      .values({ publicId: newPublicId(), name, slug: name.toLowerCase(), kind: "client" })
      .returning()
  )[0]!;
  const client = (
    await db
      .insert(clients)
      .values({ publicId: newPublicId(), organizationId: org.id })
      .returning()
  )[0]!;
  const user = (
    await db
      .insert(users)
      .values({
        publicId: newPublicId(),
        email: `owner@${name.toLowerCase()}.test`,
        username: `${name.toLowerCase()}-owner`,
        passwordHash: await hashPassword(PASSWORD),
        passwordAlgo: "pbkdf2-sha256",
        role: "client",
        status: "active",
      })
      .returning()
  )[0]!;
  await db.insert(organizationMemberships).values({ organizationId: org.id, userId: user.id });
  return { org, client, user };
}

/** The claims a signed-in browser's token carries. */
function claimsFor(user: { id: string; sessionEpoch: number }) {
  return { userId: user.id, sessionEpoch: user.sessionEpoch };
}

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
});

afterAll(async () => close());

beforeEach(async () => {
  await db.delete(auditLog);
  await db.delete(passwordResetTokens);
  await db.delete(organizationMemberships);
  await db.delete(clients);
  await db.delete(users);
  await db.delete(organizations);

  const admin = (
    await db
      .insert(users)
      .values({
        publicId: newPublicId(),
        email: "admin@example.test",
        username: "the-admin",
        passwordHash: await hashPassword(ADMIN_PASSWORD),
        passwordAlgo: "pbkdf2-sha256",
        role: "admin",
        status: "active",
      })
      .returning()
  )[0]!;
  ctx = adminContextFrom({
    userId: admin.id,
    organizationId: null,
    role: "admin",
    status: "active",
    sessionEpoch: admin.sessionEpoch,
  });
});

describe("credentials sign-in", () => {
  it("signs a client in while their record is active", async () => {
    const { user } = await seedClientUser();

    const result = await authenticate(db, user.email, PASSWORD);

    expect(result).toMatchObject({ ok: true, user: { userId: user.id } });
  });

  it("refuses a removed client, by email and by username, with the closed reason", async () => {
    const { client, user } = await seedClientUser();
    await archiveClient(ctx, db, client.publicId);

    expect(await authenticate(db, user.email, PASSWORD)).toEqual({ ok: false, reason: "closed" });
    expect(await authenticate(db, user.username!, PASSWORD)).toEqual({
      ok: false,
      reason: "closed",
    });
  });

  it("does not say the account is closed to someone who has the wrong password", async () => {
    // "Closed" is only ever told to a caller who proved they hold the account;
    // told to anyone else it would confirm which addresses were clients.
    const { client, user } = await seedClientUser();
    await archiveClient(ctx, db, client.publicId);

    expect(await authenticate(db, user.email, "not-the-password")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("does not count a closed sign-in as a success", async () => {
    const { client, user } = await seedClientUser();
    await archiveClient(ctx, db, client.publicId);

    await authenticate(db, user.email, PASSWORD);

    expect((await db.select().from(users).where(eq(users.id, user.id)))[0]!.lastLoginAt).toBeNull();
  });

  it("lets the client sign in again once they are restored", async () => {
    const { client, user } = await seedClientUser();
    await archiveClient(ctx, db, client.publicId);
    await restoreClient(ctx, db, client.publicId);

    expect(await authenticate(db, user.email, PASSWORD)).toMatchObject({ ok: true });
  });

  it("never affects an admin", async () => {
    const result = await authenticate(db, "admin@example.test", ADMIN_PASSWORD);

    expect(result).toMatchObject({ ok: true, user: { role: "admin" } });
  });

  it("does not affect another client when one is removed", async () => {
    const removed = await seedClientUser("Gone");
    const kept = await seedClientUser("Kept");
    await archiveClient(ctx, db, removed.client.publicId);

    expect(await authenticate(db, kept.user.email, PASSWORD)).toMatchObject({ ok: true });
  });

  it("does not turn a disabled user into an enabled one on restore", async () => {
    const { client, user } = await seedClientUser();
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, user.id));
    await archiveClient(ctx, db, client.publicId);
    await restoreClient(ctx, db, client.publicId);

    expect(await authenticate(db, user.email, PASSWORD)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("a session that is already signed in", () => {
  it("is honoured while the client is active", async () => {
    const { user } = await seedClientUser();

    expect(await resolveSession(db, claimsFor(user))).toMatchObject({ userId: user.id });
  });

  it("is cut off on its next request once the client is removed", async () => {
    const { client, user } = await seedClientUser();
    const claims = claimsFor(user);
    expect(await resolveSession(db, claims)).not.toBeNull();

    await archiveClient(ctx, db, client.publicId);

    expect(await resolveSession(db, claims)).toBeNull();
  });

  it("works again after Restore, with no new sign-in needed", async () => {
    const { client, user } = await seedClientUser();
    const claims = claimsFor(user);
    await archiveClient(ctx, db, client.publicId);
    await restoreClient(ctx, db, client.publicId);

    expect(await resolveSession(db, claims)).toMatchObject({ userId: user.id });
  });

  it("is never cut off for an admin, even one who belongs to a removed client's organization", async () => {
    // The worst case for the rule: an admin whose membership points at an
    // archived client. Role decides, not the organization they happen to be in.
    const { org, client } = await seedClientUser();
    const admin = (await db.select().from(users).where(eq(users.email, "admin@example.test")))[0]!;
    await db.insert(organizationMemberships).values({ organizationId: org.id, userId: admin.id });
    await archiveClient(ctx, db, client.publicId);

    expect(await resolveSession(db, claimsFor(admin))).toMatchObject({ userId: admin.id, role: "admin" });
    expect(await authenticate(db, "admin@example.test", ADMIN_PASSWORD)).toMatchObject({ ok: true });
  });

  it("leaves every other client's session alone", async () => {
    const removed = await seedClientUser("Gone");
    const kept = await seedClientUser("Kept");
    await archiveClient(ctx, db, removed.client.publicId);

    expect(await resolveSession(db, claimsFor(kept.user))).not.toBeNull();
  });
});

describe("password reset", () => {
  it("sends nothing to a removed client, and writes no token", async () => {
    const { client, user } = await seedClientUser();
    await archiveClient(ctx, db, client.publicId);

    expect(await requestPasswordReset(db, user.email)).toBeNull();
    expect(await db.select().from(passwordResetTokens)).toHaveLength(0);
  });

  it("sends the link again once the client is restored", async () => {
    const { client, user } = await seedClientUser();
    await archiveClient(ctx, db, client.publicId);
    await restoreClient(ctx, db, client.publicId);

    expect(await requestPasswordReset(db, user.email)).not.toBeNull();
  });

  it("refuses a link that was emailed before the client was removed, and leaves the password alone", async () => {
    const { client, user } = await seedClientUser();
    const grant = (await requestPasswordReset(db, user.email))!;
    await archiveClient(ctx, db, client.publicId);

    expect(await inspectResetToken(db, grant.token)).toEqual({ ok: false, reason: "closed" });
    expect(await redeemPasswordReset(db, grant.token, "a-brand-new-password-91")).toEqual({
      ok: false,
      reason: "closed",
    });

    const after = (await db.select().from(users).where(eq(users.id, user.id)))[0]!;
    expect(await verifyPassword(PASSWORD, after.passwordHash)).toBe(true);
    expect(after.sessionEpoch).toBe(user.sessionEpoch);
  });

  it("does not burn the link, so it works if the client is restored within the hour", async () => {
    const { client, user } = await seedClientUser();
    const grant = (await requestPasswordReset(db, user.email))!;
    await archiveClient(ctx, db, client.publicId);
    await redeemPasswordReset(db, grant.token, "a-brand-new-password-91");
    await restoreClient(ctx, db, client.publicId);

    expect(await redeemPasswordReset(db, grant.token, "a-brand-new-password-91")).toMatchObject({
      ok: true,
    });
  });
});
