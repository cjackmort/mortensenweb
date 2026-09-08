import { and, eq } from "drizzle-orm";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { mediaAssets, mediaDerivatives } from "@/db/schema";
import { tenantContextFrom } from "@/db/repositories/context";
import { mediaDriver } from "@/lib/storage/driver";

/**
 * Serving a client their own image.
 *
 * Session-authenticated and tenant-scoped, which is what separates this from
 * `/api/attachments/[token]`: that route exists for a GitHub Actions runner
 * that can hold no session, so it uses a signed link. A person looking at their
 * own library *does* hold one, and using a signed link here would be strictly
 * weaker — a URL that keeps working after sign-out, in a browser cache, in
 * anyone's history.
 *
 * ## Every refusal is a 404
 *
 * Another tenant's id, a deleted asset, a variant that has not been generated
 * yet, and one a scanner would flag all answer identically. Distinguishing them
 * tells anyone probing which ids are real.
 *
 * ## Why the content type is not taken from storage
 *
 * The database row is authoritative, and even then only if it is on the
 * allowlist below. Echoing back a type that travelled through storage would
 * reintroduce exactly the trust that byte-sniffing at upload exists to remove —
 * and this origin holds a session cookie, so an "image" served as HTML runs in
 * it.
 */

export const dynamic = "force-dynamic";

const NOT_FOUND = () => new Response(null, { status: 404 });

const SERVEABLE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const DERIVATIVE_VARIANTS = new Set([
  "thumb",
  "preview",
  "web_sm",
  "web_md",
  "web_lg",
]);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ assetId: string; variant: string }> },
): Promise<Response> {
  const user = await currentUser();
  if (!user?.organizationId) return NOT_FOUND();

  const { assetId, variant } = await params;
  if (variant !== "original" && !DERIVATIVE_VARIANTS.has(variant)) return NOT_FOUND();

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();

  const assetRows = await db
    .select({
      id: mediaAssets.id,
      storageKey: mediaAssets.storageKey,
      contentType: mediaAssets.contentType,
      status: mediaAssets.status,
      filename: mediaAssets.originalFilename,
    })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.publicId, assetId),
        // The tenancy check. Not a filter added for tidiness — it is the only
        // thing standing between a guessed public id and another client's
        // photographs.
        eq(mediaAssets.organizationId, ctx.organizationId),
      ),
    )
    .limit(1);

  const asset = assetRows[0];
  if (!asset) return NOT_FOUND();
  if (asset.status === "quarantined") return NOT_FOUND();

  let key: string | null = null;
  let contentType: string | null = null;

  if (variant === "original") {
    key = asset.storageKey;
    contentType = asset.contentType;
  } else {
    const derivativeRows = await db
      .select({
        storageKey: mediaDerivatives.storageKey,
        contentType: mediaDerivatives.contentType,
      })
      .from(mediaDerivatives)
      .where(
        and(
          eq(mediaDerivatives.assetId, asset.id),
          eq(mediaDerivatives.kind, variant as "thumb"),
        ),
      )
      .limit(1);
    key = derivativeRows[0]?.storageKey ?? null;
    contentType = derivativeRows[0]?.contentType ?? null;
  }

  if (!key) return NOT_FOUND();

  const object = await mediaDriver().get(key);
  if (!object) return NOT_FOUND();

  const safeType = contentType && SERVEABLE.has(contentType) ? contentType : null;
  if (!safeType) return NOT_FOUND();

  return new Response(object.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": safeType,
      "Content-Length": String(object.bytes.byteLength),
      // Derivatives are immutable for the life of a key, so a long private
      // cache is safe and makes the grid feel instant on a second visit.
      // `private` keeps it in the one browser that authenticated for it and out
      // of any shared proxy — these are one tenant's images.
      "Cache-Control":
        variant === "original"
          ? "private, no-store"
          : "private, max-age=3600, must-revalidate",
      // Never rendered as a page. An image is bytes to draw, and this origin
      // carries a session cookie.
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition":
        variant === "original"
          ? `attachment; filename="${asset.filename.replace(/["\\]/g, "")}"`
          : "inline",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
    },
  });
}
