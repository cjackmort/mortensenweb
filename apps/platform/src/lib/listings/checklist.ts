import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "@/db/client";
import { listingSteps, users } from "@/db/schema";
import {
  isListingStepKey,
  LISTING_STEPS,
  listingProgress,
  MAX_LISTING_NOTE_CHARS,
  type ListingProgress,
  type ListingStepKey,
} from "./steps";

/**
 * The checklist as both pages show it, and the one write both pages make.
 *
 * Shared by the client and admin repositories, which differ only in how they
 * establish that the site is theirs to touch. Neither of these functions
 * checks that: `siteIds` and `site` arrive already scoped, and the callers'
 * tests pin that a foreign site never reaches here.
 */

export interface ListingStepView {
  key: ListingStepKey;
  title: string;
  why: string;
  url: string;
  done: boolean;
  note: string | null;
  markedAt: Date | null;
  /** The user who marked it, as the page should name them. Null when nobody has. */
  markedBy: { userId: string; name: string; role: "admin" | "client" } | null;
}

export interface SiteChecklist {
  sitePublicId: string;
  siteName: string;
  steps: ListingStepView[];
  progress: ListingProgress;
}

export interface MarkListingStepInput {
  stepKey: string;
  /** Omitted: the state stays and only the note changes. */
  done?: boolean;
  /** Omitted: the note stays. Empty string clears it. */
  note?: string;
}

export type MarkResult = { ok: true; message: string } | { ok: false; message: string };

/** Every step for each of the given sites, in checklist order, with the rows laid over the defaults. */
export async function checklistsFor(
  db: Database,
  sitesToShow: ReadonlyArray<{ id: string; publicId: string; name: string }>,
): Promise<SiteChecklist[]> {
  if (sitesToShow.length === 0) return [];

  const rows = await db
    .select({
      siteId: listingSteps.siteId,
      stepKey: listingSteps.stepKey,
      state: listingSteps.state,
      note: listingSteps.note,
      markedAt: listingSteps.markedAt,
      markedBy: listingSteps.markedBy,
      markerName: users.name,
      markerEmail: users.email,
      markerRole: users.role,
    })
    .from(listingSteps)
    .leftJoin(users, eq(users.id, listingSteps.markedBy))
    .where(
      inArray(
        listingSteps.siteId,
        sitesToShow.map((s) => s.id),
      ),
    );

  return sitesToShow.map((site) => {
    const bySite = rows.filter((r) => r.siteId === site.id);
    const steps = LISTING_STEPS.map((definition): ListingStepView => {
      const row = bySite.find((r) => r.stepKey === definition.key);
      return {
        key: definition.key,
        title: definition.title,
        why: definition.why,
        url: definition.url,
        done: row?.state === "done",
        note: row?.note ?? null,
        markedAt: row?.markedAt ?? null,
        markedBy:
          row?.markedBy && row.markerRole
            ? {
                userId: row.markedBy,
                name: row.markerName ?? row.markerEmail ?? "someone",
                role: row.markerRole,
              }
            : null,
      };
    });
    return { sitePublicId: site.publicId, siteName: site.name, steps, progress: listingProgress(steps) };
  });
}

/**
 * Mark one step on one site. Upserts: a site has no rows until someone
 * touches it. `marked_by` / `marked_at` move only when the state changes,
 * so a note added later does not rewrite who did the work.
 */
export async function writeListingStep(
  db: Database,
  site: { id: string; organizationId: string },
  actorUserId: string,
  input: MarkListingStepInput,
): Promise<MarkResult> {
  if (!isListingStepKey(input.stepKey)) {
    return { ok: false, message: "That is not a step on the list." };
  }
  const note = input.note === undefined ? undefined : input.note.trim();
  if (note !== undefined && note.length > MAX_LISTING_NOTE_CHARS) {
    return { ok: false, message: `Keep the note under ${MAX_LISTING_NOTE_CHARS} characters.` };
  }
  if (input.done === undefined && note === undefined) {
    return { ok: false, message: "Nothing to save." };
  }

  const [existing] = await db
    .select({ id: listingSteps.id, state: listingSteps.state })
    .from(listingSteps)
    .where(and(eq(listingSteps.siteId, site.id), eq(listingSteps.stepKey, input.stepKey)))
    .limit(1);

  const now = new Date();
  const nextState = input.done === undefined ? (existing?.state ?? "todo") : input.done ? "done" : "todo";
  const stateChanged = nextState !== (existing?.state ?? "todo");
  const stamp = stateChanged ? { markedBy: actorUserId, markedAt: now } : {};

  if (existing) {
    await db
      .update(listingSteps)
      .set({
        state: nextState,
        ...(note === undefined ? {} : { note: note || null }),
        ...stamp,
        updatedAt: now,
      })
      .where(eq(listingSteps.id, existing.id));
  } else {
    await db.insert(listingSteps).values({
      organizationId: site.organizationId,
      siteId: site.id,
      stepKey: input.stepKey,
      state: nextState,
      note: note ? note : null,
      ...stamp,
    });
  }

  const title = LISTING_STEPS.find((s) => s.key === input.stepKey)?.title ?? input.stepKey;
  if (!stateChanged) return { ok: true, message: "Note saved." };
  return { ok: true, message: nextState === "done" ? `${title}: done.` : `${title}: back to not done.` };
}
