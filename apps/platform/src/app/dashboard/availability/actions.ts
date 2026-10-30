"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { AuthorizationError, NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import {
  bookingAccess,
  removeDateOverride,
  saveDateOverride,
  saveRules,
  saveWeeklyHours,
} from "@/db/repositories/client/availability";
import { decideAppointment, type Decision } from "@/db/repositories/client/availability-bookings";
import { disconnectCalendar } from "@/db/repositories/client/availability-calendar";

/**
 * Availability mutations. Each re-derives the tenant from the session — a
 * server action is a public POST endpoint — and each re-checks that the
 * client takes bookings, because the page not showing a form is no defence
 * against a request made by hand.
 */

export type AvailabilityActionResult = { ok: boolean; message: string };

const PAGE = "/dashboard/availability";
const NOT_SIGNED_IN: AvailabilityActionResult = { ok: false, message: "Please sign in again." };
const NOT_ON: AvailabilityActionResult = { ok: false, message: "Online booking isn't switched on for your account." };
const READ_ONLY: AvailabilityActionResult = {
  ok: false,
  message: "You are viewing this portal as the client, so nothing here can be changed.",
};

async function session() {
  const user = await currentUser();
  if (!user?.organizationId || user.role !== "client") return null;
  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  if (!(await bookingAccess(db, ctx)).allowed) return "off" as const;
  return { ctx, db };
}

/** Run a write with the session's checks, turning the expected refusals into messages. */
async function run(
  write: (s: NonNullable<Exclude<Awaited<ReturnType<typeof session>>, "off">>) => Promise<AvailabilityActionResult>,
): Promise<AvailabilityActionResult> {
  const s = await session();
  if (!s) return NOT_SIGNED_IN;
  if (s === "off") return NOT_ON;
  try {
    const result = await write(s);
    if (result.ok) revalidatePath(PAGE);
    return result;
  } catch (error) {
    if (error instanceof AuthorizationError) return READ_ONLY;
    if (error instanceof NotFoundError) return { ok: false, message: "That is no longer here. Reload the page." };
    throw error;
  }
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "");

export async function saveHoursAction(_previous: AvailabilityActionResult | null, form: FormData) {
  return run(({ db, ctx }) => saveWeeklyHours(db, ctx, text(form, "hours")));
}

export async function saveRulesAction(_previous: AvailabilityActionResult | null, form: FormData) {
  return run(({ db, ctx }) =>
    saveRules(db, ctx, {
      timeZone: text(form, "timeZone"),
      slotMinutes: text(form, "slotMinutes"),
      bufferMinutes: text(form, "bufferMinutes"),
      minNoticeMinutes: text(form, "minNoticeMinutes"),
      horizonDays: text(form, "horizonDays"),
      requiresApproval: form.get("requiresApproval"),
    }),
  );
}

export async function saveDayAction(_previous: AvailabilityActionResult | null, form: FormData) {
  return run(({ db, ctx }) =>
    saveDateOverride(db, ctx, {
      date: text(form, "date"),
      mode: text(form, "mode"),
      start: text(form, "start"),
      end: text(form, "end"),
    }),
  );
}

export async function removeDayAction(_previous: AvailabilityActionResult | null, form: FormData) {
  return run(({ db, ctx }) => removeDateOverride(db, ctx, text(form, "day")));
}

const DECISIONS: ReadonlySet<string> = new Set<Decision>(["approve", "decline", "cancel"]);

export async function decideAction(_previous: AvailabilityActionResult | null, form: FormData) {
  const decision = text(form, "decision");
  if (!DECISIONS.has(decision)) return { ok: false, message: "Unknown action." };
  return run(({ db, ctx }) => decideAppointment(db, ctx, text(form, "booking"), decision as Decision));
}

export async function disconnectCalendarAction(_previous: AvailabilityActionResult | null, _form: FormData) {
  return run(async ({ db, ctx }) =>
    (await disconnectCalendar(db, ctx))
      ? { ok: true, message: "Google Calendar is disconnected. Your website now offers times from your hours alone." }
      : { ok: false, message: "Google Calendar wasn't connected." },
  );
}
