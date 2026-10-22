import type { Database } from "@/db/client";
import type { DraftProfile } from "./draft";

/**
 * Publishing a showcase as a Google Business Profile post.
 *
 * ## The seam
 *
 * The Google connection is its own feature (Google profile management,
 * `lib/google-business` on its own branch). This file does not depend on it.
 * It defines the one thing a showcase needs — publish a post for this client,
 * or say there is no connection — and ships the honest default: not
 * connected, so the client is given the text and the image to post
 * themselves, marked "post manually".
 *
 * **Integration point:** once Google profile management is merged, replace
 * the body of `googlePostPublisher()` with an adapter over its
 * `publishGooglePost(ctx, db, clientPublicId, { summary, mediaAssetPublicId, cta })`
 * — the input below has the same shape on purpose. Nothing else here changes.
 *
 * The photo goes as a library asset id rather than as bytes: the publisher
 * mints its own short-lived signed link for Google to fetch, the same way the
 * agent receives photos.
 */

/** Google caps a local post's summary at 1,500 characters. */
export const GOOGLE_SUMMARY_LIMIT = 1500;

export type GooglePostCta =
  | { actionType: "CALL" }
  | { actionType: "BOOK" | "LEARN_MORE"; url: string };

export interface GooglePostInput {
  summary: string;
  mediaAssetPublicId: string | null;
  cta: GooglePostCta | null;
}

export type PublishResult = { ok: true; postName: string | null } | { ok: false; message: string };

export interface GooglePostPublisher {
  /** Whether this client's Business Profile is connected and can take a post. */
  isConnected(db: Database, organizationId: string): Promise<boolean>;
  publish(db: Database, organizationId: string, post: GooglePostInput): Promise<PublishResult>;
}

const NOT_CONNECTED: GooglePostPublisher = {
  isConnected: async () => false,
  publish: async () => ({ ok: false, message: "Google Business Profile is not connected." }),
};

/** The publisher in use. See the integration point above. */
export function googlePostPublisher(): GooglePostPublisher {
  return NOT_CONNECTED;
}

function withinLimit(text: string): string {
  if (text.length <= GOOGLE_SUMMARY_LIMIT) return text;
  const cut = text.slice(0, GOOGLE_SUMMARY_LIMIT);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return lastStop > 0 ? cut.slice(0, lastStop + 1) : `${cut.slice(0, GOOGLE_SUMMARY_LIMIT - 1)}…`;
}

/**
 * The post, from the approved write-up. A phone number becomes Google's own
 * call button — the post's button dials the number on the profile — so the
 * text does not need to carry it twice.
 */
export function googlePostFor(
  showcase: { writeUp: string; coverAssetPublicId: string | null },
  profile: DraftProfile,
): GooglePostInput {
  const phone = profile.phone?.trim();
  const booking = profile.bookingUrl?.trim();
  const cta: GooglePostCta | null = phone
    ? { actionType: "CALL" }
    : booking
      ? { actionType: "BOOK", url: booking }
      : null;

  return {
    summary: withinLimit(showcase.writeUp.trim()),
    mediaAssetPublicId: showcase.coverAssetPublicId,
    cta,
  };
}
