import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { mediaAssets } from "@/db/schema";
import { mediaDriver } from "@/lib/storage/driver";
import { verifyMediaAssetToken } from "@/lib/storage/signed-links";

/**
 * Serving one library original to the agent.
 *
 * Unauthenticated by necessity, exactly like `/api/attachments/[token]`: the
 * reader is a GitHub Actions runner, which holds no session and cannot be given
 * one. The signed token in the path *is* the authorisation, and it names
 * exactly one asset for a bounded window.
 *
 * ## What bounds the agent's access
 *
 * A token is minted only at dispatch, and only for assets that request
 * actually selected. There is no parameter here that takes an asset id in any
 * other form — the id exists only inside the signed payload — so a job cannot
 * widen its own access by editing a URL, and cannot reach an asset the client
 * did not choose for it.
 *
 * The prefix inside the signed payload additionally stops an attachment token
 * from resolving here, or one of these from resolving against
 * `request_attachments`.
 *
 * ## Every refusal is a 404
 *
 * Expired, forged, malformed, unknown, trashed, or not yet ready all answer
 * identically. There is no legitimate caller who benefits from knowing which.
 */

export const dynamic = "force-dynamic";

const NOT_FOUND = () => new Response(null, { status: 404 });

const SERVEABLE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;

  const check = await verifyMediaAssetToken(token);
  if (!check.ok) return NOT_FOUND();

  const db = await getDb();

  const rows = await db
    .select({
      storageKey: mediaAssets.storageKey,
      contentType: mediaAssets.contentType,
      status: mediaAssets.status,
      byteSize: mediaAssets.byteSize,
      deletedAt: mediaAssets.deletedAt,
    })
    .from(mediaAssets)
    .where(eq(mediaAssets.publicId, check.assetPublicId))
    .limit(1);

  const row = rows[0];
  if (!row || !row.storageKey) return NOT_FOUND();

  // A trashed or quarantined asset is not served, whatever the token says. A
  // decision made after the link was minted outranks the link.
  if (row.deletedAt !== null) return NOT_FOUND();
  if (row.status !== "ready") return NOT_FOUND();

  const contentType =
    row.contentType && SERVEABLE.has(row.contentType) ? row.contentType : null;
  if (!contentType) return NOT_FOUND();

  const object = await mediaDriver().get(row.storageKey);
  if (!object) return NOT_FOUND();

  return new Response(object.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(object.bytes.byteLength),
      // The agent downloads bytes. A person following the link out of
      // curiosity gets a file, not a page that executes in this origin.
      "Content-Disposition": "attachment",
      "X-Content-Type-Options": "nosniff",
      // The link expires, so a cache holding it would outlive the
      // authorisation that produced it.
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
    },
  });
}
