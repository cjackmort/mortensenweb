import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import type { AdminContext } from "@/db/repositories/context";
import {
  auditLog,
  clients,
  organizationMemberships,
  organizations,
  users,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { hashPassword } from "@/lib/auth/password";
import {
  generateTemporaryPassword,
  resolveUniqueUsername,
  temporaryPasswordExpiry,
} from "@/lib/auth/credentials";

/**
 * Client activation: the moment a signed, paid client becomes able to sign in.
 *
 * This is deliberately a single operation that both creates the credential and
 * hands it back exactly once. The plaintext temporary password is returned to
 * the caller and never stored — only its PBKDF2 hash reaches the database — so
 * if the operator loses it, the only remedy is to reissue, which is correct.
 */

export interface ActivationRequest {
  organizationId: string;
  /** Person who will sign in. Their email receives the welcome message. */
  contactName: string;
  contactEmail: string;
}

export interface ActivationResult {
  userId: string;
  username: string;
  /** Plaintext, returned once. Never persisted, never logged. */
  temporaryPassword: string;
  expiresAt: Date;
  email: string;
}

export class ActivationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "organization_not_found"
      | "email_in_use"
      | "already_activated",
  ) {
    super(message);
    this.name = "ActivationError";
  }
}

/**
 * Issue sign-in credentials for a client organization.
 *
 * Preconditions the caller is responsible for: the client has agreed terms and
 * paid. The platform does not infer that from a payment row, because a payment
 * can be recorded for many reasons and activation grants real access.
 */
export async function activateClient(
  ctx: AdminContext,
  db: Database,
  request: ActivationRequest,
): Promise<ActivationResult> {
  const email = request.contactEmail.trim().toLowerCase();

  const orgRows = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, request.organizationId))
    .limit(1);
  const organization = orgRows[0];
  if (!organization) {
    throw new ActivationError("Organization not found.", "organization_not_found");
  }

  const existing = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing[0]) {
    // Reactivating an existing account is a separate, deliberate operation:
    // silently resetting someone's password because an email matched would be
    // an account-takeover vector.
    throw new ActivationError(
      "That email already has an account. Reissue credentials for it instead.",
      "email_in_use",
    );
  }

  const username = await resolveUniqueUsername(organization.name, async (candidate) => {
    const hit = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, candidate))
      .limit(1);
    return hit.length > 0;
  });

  const temporaryPassword = generateTemporaryPassword();
  const expiresAt = temporaryPasswordExpiry();
  const now = new Date();

  const inserted = await db
    .insert(users)
    .values({
      publicId: newPublicId(),
      email,
      username,
      name: request.contactName.trim() || null,
      passwordHash: await hashPassword(temporaryPassword),
      passwordAlgo: "pbkdf2-sha256",
      passwordUpdatedAt: now,
      // The two flags that make this a temporary credential rather than a
      // permanent one. The schema check constraint refuses the first without
      // the second.
      mustChangePassword: true,
      tempPasswordExpiresAt: expiresAt,
      role: "client",
      status: "active",
      invitedAt: now,
    })
    .returning({ id: users.id });

  const userId = inserted[0]!.id;

  await db.insert(organizationMemberships).values({
    organizationId: organization.id,
    userId,
    role: "owner",
  });

  await db
    .update(clients)
    .set({ onboardingStatus: "credentials_issued", updatedAt: now })
    .where(eq(clients.organizationId, organization.id));

  // The audit row records that credentials were issued, never what they were.
  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: organization.id,
    action: "client.activated",
    entityType: "user",
    entityId: userId,
    metadata: { username, expiresAt: expiresAt.toISOString() },
  });

  return { userId, username, temporaryPassword, expiresAt, email };
}

/**
 * Reissue a temporary password for an existing client — the "I lost the email"
 * and "it expired" path.
 *
 * Advances the session epoch, so any session opened with the previous
 * credential is terminated at the same moment.
 */
export async function reissueTemporaryPassword(
  ctx: AdminContext,
  db: Database,
  userId: string,
): Promise<ActivationResult> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const user = rows[0];
  if (!user) throw new ActivationError("User not found.", "organization_not_found");

  const temporaryPassword = generateTemporaryPassword();
  const expiresAt = temporaryPasswordExpiry();
  const now = new Date();

  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(temporaryPassword),
      passwordUpdatedAt: now,
      mustChangePassword: true,
      tempPasswordExpiresAt: expiresAt,
      failedLoginCount: 0,
      lockedUntil: null,
      sessionEpoch: user.sessionEpoch + 1,
      updatedAt: now,
    })
    .where(eq(users.id, userId));

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    action: "client.credentials_reissued",
    entityType: "user",
    entityId: userId,
    metadata: { expiresAt: expiresAt.toISOString() },
  });

  return {
    userId,
    username: user.username ?? user.email,
    temporaryPassword,
    expiresAt,
    email: user.email,
  };
}
