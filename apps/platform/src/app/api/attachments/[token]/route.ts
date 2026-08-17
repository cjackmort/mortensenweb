import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { requestAttachments } from "@/db/schema";
import { storageDriver } from "@/lib/storage/driver";
import { verifyAttachmentToken } from "@/lib/storage/signed-links";

/**
 * Serving a client's uploaded image to the agent.
 *
 * Unauthenticated by necessity: the reader is a GitHub Actions runner, which
 * has no session and cannot be given one. The signed token in the path *is* the
 * authorisation, and it names exactly one attachment for a bounded window.
 *
 * ## Why this does not go through the tenant-scoped repository
 *
 * `getAttachmentForTenant` needs a `TenantContext`, and deliberately so — it is
 * the path a signed-in client uses, and it must never resolve another
 * organization's image. There is no session here to build one from.
 *
 * The token replaces that check rather than bypassing it. It was minted against
 * one attachment id by code that had already established ownership, so the
 * scope is fixed at signing time instead of query time. What this route must
 * not do is accept an attachment id from the caller in any other form — and it
 * does not: the id exists only inside the signed payload.
 *
 * ## Every refusal is 404
 *
 * Expired, forged, malformed, unknown, or flagged by a scanner all answer the
 * same way. Distinguishing them would confirm which ids are real to anyone
 * probing, and there is no legitimate caller who benefits from knowing why.
 */

export const dynamic = "force-dynamic";

const NOT_FOUND = () => new Response(null, { status: 404 });

/** Content types we are willing to echo back, regardless of what is stored. */
const SERVEABLE = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;

  const check = await verifyAttachmentToken(token);
  if (!check.ok) return NOT_FOUND();

  const db = await getDb();

  const rows = await db
    .select({
      r2Key: requestAttachments.r2Key,
      contentTypeSniffed: requestAttachments.contentTypeSniffed,
      scanStatus: requestAttachments.scanStatus,
      byteSize: requestAttachments.byteSize,
    })
    .from(requestAttachments)
    .where(eq(requestAttachments.publicId, check.attachmentPublicId))
    .limit(1);

  const row = rows[0];
  if (!row) return NOT_FOUND();

  // A scanner's verdict outranks a valid token. `flagged` means do not serve,
  // and a link minted before the scan ran must not outlive that decision.
  if (row.scanStatus === "flagged") return NOT_FOUND();

  const object = await storageDriver().get(row.r2Key);
  if (!object) return NOT_FOUND();

  // The stored sniffed type is authoritative, and then only if it is on the
  // allowlist. Echoing a stored value unchecked is how a file uploaded as an
  // image gets served as something a browser will execute.
  const declared = row.contentTypeSniffed ?? "";
  const contentType = SERVEABLE.has(declared) ? declared : "application/octet-stream";

  return new Response(object.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(row.byteSize),
      // Never rendered inline in a browser. The agent fetches bytes; a person
      // following the link out of curiosity gets a download, not a page that
      // executes in our origin.
      "Content-Disposition": "attachment",
      "X-Content-Type-Options": "nosniff",
      // The link expires, so a cache holding it past that point would outlive
      // the authorisation that produced it.
      "Cache-Control": "private, no-store",
      // Nothing here belongs in a search index or a third party's referrer log.
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
    },
  });
}
