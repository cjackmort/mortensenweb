"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { requireGrowthFeature } from "@/db/repositories/client/growth";
import {
  addReviewSuppression,
  removeReviewSuppression,
  saveReviewLink,
  saveReviewMessage,
  type ReviewResult,
} from "@/db/repositories/client/reviews";
import { sendReviewRequest } from "@/db/repositories/client/review-send";
import { searchPlaces, type FoundPlace } from "@/lib/reviews/places";

/**
 * Review request mutations. Each re-derives the tenant from the session — a
 * server action is a public POST endpoint — and each checks the plan, because
 * sending is an email in the business's name and setup is part of a paid
 * feature.
 */

type Refusal = { ok: false; message: string };

const NOT_SIGNED_IN: Refusal = { ok: false, message: "Please sign in again." };
const NOT_IN_PLAN: Refusal = {
  ok: false,
  message: "Your plan does not include review requests. See Growth to add it.",
};

async function session() {
  const user = await currentUser();
  if (!user?.organizationId || user.role !== "client") return null;
  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  if (!(await requireGrowthFeature(db, ctx, "reviews"))) return "locked" as const;
  return { ctx, db };
}

function refresh() {
  revalidatePath("/dashboard/growth/reviews", "layout");
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "");

export async function saveReviewLinkAction(_previous: ReviewResult | null, form: FormData): Promise<ReviewResult> {
  const s = await session();
  if (!s) return NOT_SIGNED_IN;
  if (s === "locked") return NOT_IN_PLAN;
  const result = await saveReviewLink(s.db, s.ctx, { input: text(form, "link") });
  if (result.ok) refresh();
  return result;
}

export type PlaceSearchResult =
  | { ok: true; places: FoundPlace[]; query: string }
  | { ok: false; message: string };

export async function findPlacesAction(_previous: PlaceSearchResult | null, form: FormData): Promise<PlaceSearchResult> {
  const s = await session();
  if (!s) return NOT_SIGNED_IN;
  if (s === "locked") return NOT_IN_PLAN;
  const query = text(form, "query").trim();
  if (query.length < 3) return { ok: false, message: "Type your business name and town." };

  const found = await searchPlaces(query);
  if (!found.ok) {
    return {
      ok: false,
      message:
        found.reason === "not_configured"
          ? "Searching Google is not switched on. Paste your review link instead."
          : "Google did not answer just now. Try again, or paste your review link instead.",
    };
  }
  if (found.places.length === 0) return { ok: false, message: "Google found nothing for that. Try the name as it appears on Google Maps." };
  return { ok: true, places: found.places, query };
}

export async function saveReviewMessageAction(_previous: ReviewResult | null, form: FormData): Promise<ReviewResult> {
  const s = await session();
  if (!s) return NOT_SIGNED_IN;
  if (s === "locked") return NOT_IN_PLAN;
  const result = await saveReviewMessage(s.db, s.ctx, {
    subject: text(form, "subject"),
    body: text(form, "body"),
    reminderBody: text(form, "reminderBody"),
    reminderDays: Number.parseInt(text(form, "reminderDays"), 10),
    remindersEnabled: form.get("remindersEnabled") === "on",
  });
  if (result.ok) refresh();
  return result;
}

export async function sendReviewRequestAction(_previous: ReviewResult | null, form: FormData): Promise<ReviewResult> {
  const s = await session();
  if (!s) return NOT_SIGNED_IN;
  if (s === "locked") return NOT_IN_PLAN;

  let result;
  try {
    result = await sendReviewRequest(s.db, s.ctx, {
      name: text(form, "name"),
      email: text(form, "email"),
      phone: text(form, "phone"),
      smsConsent: form.get("smsConsent") === "on",
      leadPublicId: text(form, "lead") || undefined,
    });
  } catch (error) {
    if (error instanceof NotFoundError) return { ok: false, message: "That enquiry no longer exists." };
    throw error;
  }
  // Refreshed either way: a request that failed is still recorded, and shows on the list.
  refresh();
  if (!result.ok) return result;

  const sentBy = [result.emailStatus === "sent" && "email", result.smsStatus === "sent" && "text"].filter(Boolean);
  return sentBy.length > 0
    ? { ok: true, message: `Sent by ${sentBy.join(" and ")}. It shows below, and we'll remind them once if they don't click.` }
    : { ok: true, message: "Saved, but not sent — sending isn't switched on on this server." };
}

export async function addSuppressionAction(_previous: ReviewResult | null, form: FormData): Promise<ReviewResult> {
  const s = await session();
  if (!s) return NOT_SIGNED_IN;
  if (s === "locked") return NOT_IN_PLAN;
  const result = await addReviewSuppression(s.db, s.ctx, text(form, "address"));
  if (result.ok) refresh();
  return result;
}

export async function removeSuppressionAction(_previous: ReviewResult | null, form: FormData): Promise<ReviewResult> {
  const s = await session();
  if (!s) return NOT_SIGNED_IN;
  if (s === "locked") return NOT_IN_PLAN;
  const result = await removeReviewSuppression(s.db, s.ctx, text(form, "channel"), text(form, "address"));
  if (result.ok) refresh();
  return result;
}
