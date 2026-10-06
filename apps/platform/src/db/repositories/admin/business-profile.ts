import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, businessProfiles } from "@/db/schema";
import {
  PROFILE_FIELDS,
  profileEntries,
  type BusinessDetails,
  type ProfileEntry,
} from "@/lib/business-profile";
import type { AdminContext } from "../context";

/**
 * Reading and saving a client's general information.
 *
 * Admin-only. These details are published on a live site — the phone number
 * calls go to, the link a "Book now" button opens — and changing where calls
 * and leads go is an operator decision, never one a client form makes alone.
 */

export interface BusinessProfile {
  details: BusinessDetails;
  updatedAt: Date;
  lastAppliedAt: Date | null;
}

export async function getBusinessProfile(
  db: Database,
  organizationId: string,
): Promise<BusinessProfile | null> {
  const rows = await db
    .select({
      details: businessProfiles.details,
      updatedAt: businessProfiles.updatedAt,
      lastAppliedAt: businessProfiles.lastAppliedAt,
    })
    .from(businessProfiles)
    .where(eq(businessProfiles.organizationId, organizationId))
    .limit(1);

  return rows[0] ?? null;
}

/** What the agent is given: the filled-in fields, labelled, in order. */
export async function profileEntriesFor(
  db: Database,
  organizationId: string,
): Promise<ProfileEntry[]> {
  const profile = await getBusinessProfile(db, organizationId);
  return profileEntries(profile?.details);
}

/**
 * Replace the profile with what the form held.
 *
 * The whole object, not a merge: the form shows every field, so a field missing
 * from `details` is one the operator cleared. The audit row names the fields
 * that changed and leaves their values out — the profile itself is the record.
 */
export async function saveBusinessProfile(
  ctx: AdminContext,
  db: Database,
  organizationId: string,
  details: BusinessDetails,
): Promise<{ changed: string[] }> {
  const before = (await getBusinessProfile(db, organizationId))?.details ?? {};
  const changed = PROFILE_FIELDS.map((f) => f.key).filter(
    (key) => (before[key] ?? "") !== (details[key] ?? ""),
  );
  const now = new Date();

  await db
    .insert(businessProfiles)
    .values({ organizationId, details, updatedBy: ctx.userId, updatedAt: now })
    .onConflictDoUpdate({
      target: businessProfiles.organizationId,
      set: { details, updatedBy: ctx.userId, updatedAt: now },
    });

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId,
    action: "business_profile.updated",
    entityType: "organization",
    entityId: organizationId,
    metadata: { changed },
  });

  return { changed };
}

/** Stamp the moment the details were last sent to the site as a change. */
export async function markProfileApplied(db: Database, organizationId: string): Promise<void> {
  await db
    .update(businessProfiles)
    .set({ lastAppliedAt: new Date() })
    .where(eq(businessProfiles.organizationId, organizationId));
}
