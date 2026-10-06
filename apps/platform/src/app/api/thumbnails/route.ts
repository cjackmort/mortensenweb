import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { hasCronSecret, listThumbnailTargets } from "@/lib/thumbnails";

/**
 * The sites the thumbnail job should photograph.
 *
 * Called by `.github/workflows/site-thumbnails.yml`, which holds CRON_SECRET
 * and no session. Public in `proxy.ts` for that reason; the secret is the
 * authentication, and without it this answers 401.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (!hasCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const db = await getDb();
  return NextResponse.json({ sites: await listThumbnailTargets(db) });
}
