/**
 * Google Business Profile, for the portal.
 *
 * Everything in this folder is DB-free: Google's APIs, the shapes the portal
 * keeps of them, and the rules (completeness, reply drafts, hours forms) that
 * work on those shapes. The database side — the agency's connection, which
 * location is whose, the sync — is in `db/repositories/admin/google-profile*.ts`
 * and `db/repositories/client/google-profile.ts`.
 *
 * ## For features that build on this
 *
 *  - **Review requests** wants the link that opens Google's "write a review"
 *    box for a client: `getGoogleReviewLink(db, ctx)` in
 *    `db/repositories/client/google-profile.ts`. Null when the client has no
 *    profile linked yet — fall back to whatever link you collect yourself.
 *  - **Job showcase** wants to publish a post with a photo:
 *    `publishGooglePost(ctx, db, clientPublicId, input)` in
 *    `db/repositories/admin/google-profile.ts`. It takes a media-library
 *    asset's public id for the photo, records the post in the change log, and
 *    answers `{ ok, message }` — including an honest "not connected" when
 *    Google is not set up.
 *  - Anything needing the raw API: `createGoogleBusinessClient(accessToken)`
 *    with a token from `googleAccessToken(db)`.
 */

export * from "./types";
export { createGoogleBusinessClient, type GoogleBusinessClient, POST_SUMMARY_MAX, DESCRIPTION_MAX } from "./client";
export { GoogleApiError, describeGoogleError, type GoogleErrorKind } from "./errors";
export { googleBusinessConfig, googleBusinessConfigured, expectedRedirectUri, CALLBACK_PATH } from "./config";
export { readSnapshot } from "./normalize";
export { profileChecklist, profileGaps, STALE_POST_DAYS } from "./completeness";
export { draftReviewReply, type ReplyDrafter } from "./reply-draft";
