import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { hasCronSecret, MAX_THUMBNAIL_BYTES, saveThumbnail } from "@/lib/thumbnails";

/**
 * Upload one site's home-page picture. The thumbnail job's half of the
 * exchange: CRON_SECRET in a header, a JPEG as the body.
 */

export const dynamic = "force-dynamic";

const STATUS = { unknown_site: 404, not_jpeg: 415, too_large: 413 } as const;

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ publicId: string }> },
): Promise<Response> {
  if (!hasCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  // Refused before reading, so an oversized body is never buffered.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_THUMBNAIL_BYTES) {
    return NextResponse.json({ error: "too_large" }, { status: 413 });
  }

  const { publicId } = await params;
  const bytes = new Uint8Array(await request.arrayBuffer());
  const db = await getDb();
  const result = await saveThumbnail(db, publicId, bytes);

  return result.ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: result.reason }, { status: STATUS[result.reason] });
}
