import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { requireGrowthFeature } from "@/db/repositories/client/growth";
import { loadGraphicSources } from "@/db/repositories/client/showcases";
import { GOOGLE_IMAGE, GRAPHIC_FORMATS, graphicFilename } from "@/lib/showcase/formats";
import { renderGraphic } from "@/lib/showcase/graphics";
import { storeZip } from "@/lib/showcase/zip";

/**
 * Every graphic for a showcase in one download, with the suggested caption as
 * a text file beside them, so a client posting from a laptop has everything
 * in one folder.
 */

export const dynamic = "force-dynamic";

const NOT_FOUND = () => new Response(null, { status: 404 });

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ publicId: string }> },
): Promise<Response> {
  const user = await currentUser();
  if (!user?.organizationId) return NOT_FOUND();

  const { publicId } = await params;
  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  if (!(await requireGrowthFeature(db, ctx, "showcase"))) return NOT_FOUND();

  let sources;
  try {
    sources = await loadGraphicSources(db, ctx, publicId);
  } catch (error) {
    if (error instanceof NotFoundError) return NOT_FOUND();
    throw error;
  }
  if (sources.photos.length === 0) return NOT_FOUND();

  let zip: Uint8Array;
  try {
    const images = [];
    for (const spec of [...GRAPHIC_FORMATS, GOOGLE_IMAGE]) {
      images.push({ name: graphicFilename(sources.title, spec.key), bytes: await renderGraphic({ format: spec.key, ...sources }) });
    }
    zip = storeZip([
      ...images,
      { name: "caption.txt", bytes: new TextEncoder().encode(`${sources.socialCaption}\n`) },
    ]);
  } catch (error) {
    console.error("[showcase] zip failed", {
      showcase: publicId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return new Response("The graphics could not be made just now. Please try again.", { status: 503 });
  }

  const name = graphicFilename(sources.title, "square").replace(/-square\.jpg$/, "-graphics.zip");
  return new Response(Buffer.from(zip), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
