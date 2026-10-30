import { and, eq, ne } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, businessProfiles, users } from "@/db/schema";
import { verifyPassword } from "@/lib/auth/password";
import { PROFILE_FIELDS, mergeClientDetails, type BusinessDetails } from "@/lib/business-profile";
import type { OwnDetailsInput } from "@/lib/profile/details";
import type { PreparedAvatar } from "@/lib/profile/avatar";
import { avatarDriver, avatarKey } from "@/lib/storage/driver";
import type { StorageDriver } from "@/lib/storage";
import { assertMutable, NotFoundError, type TenantContext } from "../context";

/**
 * A client's own profile: who they are to the portal, their picture, and the
 * general information about their business.
 *
 * Everything here acts on the signed-in person's own row or their own
 * organization's profile — `ctx.userId` and `ctx.organizationId`, never an
 * id from a form. An operator viewing as a client can read all of it and
 * change none of it.
 */

export interface OwnProfile {
  publicId: string;
  name: string | null;
  email: string;
  /** The sign-in handle the operator issued. Shown, not editable. */
  username: string | null;
  avatarKey: string | null;
}

export async function getOwnProfile(db: Database, ctx: TenantContext): Promise<OwnProfile> {
  const [row] = await db
    .select({
      publicId: users.publicId,
      name: users.name,
      email: users.email,
      username: users.username,
      avatarKey: users.avatarKey,
    })
    .from(users)
    .where(eq(users.id, ctx.userId))
    .limit(1);
  if (!row) throw new NotFoundError();
  return row;
}

// ---------------------------------------------------------------------------
// Name and email
// ---------------------------------------------------------------------------

export type DetailsField = "name" | "email" | "currentPassword";

export type DetailsResult =
  | { ok: true; changed: ("name" | "email")[] }
  | { ok: false; message: string; field?: DetailsField };

/**
 * Change the name and the sign-in email.
 *
 * A new email is a new credential — it is what the password-reset flow mails
 * — so it is accepted only with the current password, the way a bank asks
 * before it changes where it writes to. The name needs no such proof.
 */
export async function updateOwnDetails(
  db: Database,
  ctx: TenantContext,
  input: OwnDetailsInput,
): Promise<DetailsResult> {
  assertMutable(ctx);

  const [me] = await db
    .select({ name: users.name, email: users.email, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, ctx.userId))
    .limit(1);
  if (!me) throw new NotFoundError();

  const name = input.name.trim() || null;
  const email = input.email.trim().toLowerCase();
  const changed: ("name" | "email")[] = [];
  if (name !== me.name) changed.push("name");
  if (email !== me.email) changed.push("email");
  if (changed.length === 0) return { ok: true, changed };

  if (changed.includes("email")) {
    if (!input.currentPassword) {
      return {
        ok: false,
        field: "currentPassword",
        message: "Enter your current password to change the email you sign in with.",
      };
    }
    const valid = await verifyPassword(input.currentPassword, me.passwordHash);
    if (!valid) {
      return { ok: false, field: "currentPassword", message: "That password wasn't right." };
    }
    const [taken] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, email), ne(users.id, ctx.userId)))
      .limit(1);
    if (taken) {
      return { ok: false, field: "email", message: "That email address is already in use." };
    }
  }

  const now = new Date();
  await db.update(users).set({ name, email, updatedAt: now }).where(eq(users.id, ctx.userId));

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: ctx.organizationId,
    action: "user.details_changed",
    entityType: "user",
    entityId: ctx.userId,
    metadata: {
      changed,
      ...(changed.includes("email") ? { emailFrom: me.email, emailTo: email } : {}),
    },
    createdAt: now,
  });

  return { ok: true, changed };
}

// ---------------------------------------------------------------------------
// Picture
// ---------------------------------------------------------------------------

interface AvatarDeps {
  avatars?: StorageDriver;
  /** Eight hex characters, new per upload. Injected by tests. */
  version?: () => string;
}

function newVersion(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Store a new picture and point the row at it. The old picture is deleted
 * afterwards, best effort: a leftover file costs a few kilobytes, a row that
 * points at a deleted file costs a broken image in the top bar.
 */
export async function setOwnAvatar(
  db: Database,
  ctx: TenantContext,
  avatar: PreparedAvatar,
  deps: AvatarDeps = {},
): Promise<{ key: string }> {
  assertMutable(ctx);
  const store = deps.avatars ?? avatarDriver();

  const me = await getOwnProfile(db, ctx);
  const key = avatarKey(me.publicId, (deps.version ?? newVersion)());
  await store.put({ key, bytes: avatar.bytes, contentType: avatar.contentType });

  const now = new Date();
  await db.update(users).set({ avatarKey: key, updatedAt: now }).where(eq(users.id, ctx.userId));
  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: ctx.organizationId,
    action: "user.avatar_changed",
    entityType: "user",
    entityId: ctx.userId,
    metadata: { key },
    createdAt: now,
  });

  if (me.avatarKey && me.avatarKey !== key) {
    await store.delete(me.avatarKey).catch((error: unknown) => {
      console.warn("[profile] old avatar not deleted", {
        key: me.avatarKey,
        message: error instanceof Error ? error.message : "unknown",
      });
    });
  }
  return { key };
}

export async function removeOwnAvatar(
  db: Database,
  ctx: TenantContext,
  deps: AvatarDeps = {},
): Promise<void> {
  assertMutable(ctx);
  const me = await getOwnProfile(db, ctx);
  if (!me.avatarKey) return;

  const now = new Date();
  await db.update(users).set({ avatarKey: null, updatedAt: now }).where(eq(users.id, ctx.userId));
  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: ctx.organizationId,
    action: "user.avatar_removed",
    entityType: "user",
    entityId: ctx.userId,
    metadata: { key: me.avatarKey },
    createdAt: now,
  });
  await (deps.avatars ?? avatarDriver()).delete(me.avatarKey).catch((error: unknown) => {
    console.warn("[profile] avatar not deleted", {
      key: me.avatarKey,
      message: error instanceof Error ? error.message : "unknown",
    });
  });
}

/** The signed-in person's own picture, for the route that serves it. */
export async function readOwnAvatar(
  db: Database,
  ctx: TenantContext,
  deps: AvatarDeps = {},
): Promise<{ bytes: Uint8Array; contentType: "image/webp" } | null> {
  const me = await getOwnProfile(db, ctx);
  if (!me.avatarKey) return null;
  const stored = await (deps.avatars ?? avatarDriver()).get(me.avatarKey);
  // Always WebP: `prepareAvatar` writes nothing else, and the local disk
  // driver does not keep content types.
  return stored ? { bytes: stored.bytes, contentType: "image/webp" } : null;
}

// ---------------------------------------------------------------------------
// General information about the business
// ---------------------------------------------------------------------------

/**
 * Fields that decide where a customer's call, email or booking goes once the
 * site is updated. A change to one is flagged in the audit row and said back
 * to the client, and reaches the site only through a change request the
 * operator checks first — the profile is what the agent is told, not what the
 * site shows.
 */
export const ROUTING_FIELDS = ["phone", "email", "bookingUrl"] as const;

export interface OwnBusinessProfile {
  details: BusinessDetails;
  updatedAt: Date;
  lastAppliedAt: Date | null;
}

export async function getOwnBusinessProfile(
  db: Database,
  ctx: TenantContext,
): Promise<OwnBusinessProfile | null> {
  const [row] = await db
    .select({
      details: businessProfiles.details,
      updatedAt: businessProfiles.updatedAt,
      lastAppliedAt: businessProfiles.lastAppliedAt,
    })
    .from(businessProfiles)
    .where(eq(businessProfiles.organizationId, ctx.organizationId))
    .limit(1);
  return row ?? null;
}

/**
 * Replace the client's part of the profile with what their form held. Every
 * field they can see is replaced, not merged — a missing one was cleared on
 * purpose. The operator-only fields their form never shows are carried over
 * as stored, here rather than in the action, so no form can erase them.
 */
export async function saveOwnBusinessProfile(
  db: Database,
  ctx: TenantContext,
  submitted: BusinessDetails,
): Promise<{ changed: string[]; routingChanged: string[] }> {
  assertMutable(ctx);

  const before = (await getOwnBusinessProfile(db, ctx))?.details ?? {};
  const details = mergeClientDetails(before, submitted);
  const changed = PROFILE_FIELDS.map((f) => f.key).filter(
    (key) => (before[key] ?? "") !== (details[key] ?? ""),
  );
  const routingChanged = changed.filter((key) => (ROUTING_FIELDS as readonly string[]).includes(key));
  if (changed.length === 0) return { changed, routingChanged };

  const now = new Date();
  await db
    .insert(businessProfiles)
    .values({ organizationId: ctx.organizationId, details, updatedBy: ctx.userId, updatedAt: now })
    .onConflictDoUpdate({
      target: businessProfiles.organizationId,
      set: { details, updatedBy: ctx.userId, updatedAt: now },
    });

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: ctx.organizationId,
    action: "business_profile.updated",
    entityType: "organization",
    entityId: ctx.organizationId,
    metadata: { changed, by: "client", routingChanged },
    createdAt: now,
  });

  return { changed, routingChanged };
}
