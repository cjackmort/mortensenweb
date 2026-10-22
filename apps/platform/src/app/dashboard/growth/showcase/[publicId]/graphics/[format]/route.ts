import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { requireGrowthFeature } from "@/db/repositories/client/growth";
import { loadGraphicSources } from "@/db/repositories/client/showcases";
import { graphicFilename, isGraphicFormat } from "@/lib/showcase/formats";
import { renderGraphic } from "@/lib/showcase/graphics";

/**
 * One showcase graphic, rendered on request.
 *
 * Behind the session and scoped to the client's own showcases, like the page
 * that shows it. Nothing is stored: rendering is quick, and a graphic stored
 * at approval would go stale the moment the client changed their brand
 * colours in General information. `?download=1` asks the browser to save it.
 */

export const dynamic = "force-dynamic";

const NOT_FOUND = () => new Response(null, { status: 404 });

export async function GET(
  request: Request,
  { params }: { params: Promise<{ publicId: string; format: string }> },
): Promise<Response> {
  const user = await currentUser();
  if (!user?.organizationId) return NOT_FOUND();

  const { publicId, format } = await params;
  if (!isGraphicFormat(format)) return NOT_FOUND();

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

  let bytes: Uint8Array;
  try {
    bytes = await renderGraphic({ format, ...sources });
  } catch (error) {
    console.error("[showcase] graphic failed", {
      showcase: publicId,
      format,
      message: error instanceof Error ? error.message : "unknown",
    });
    return new Response("The graphic could not be made just now. Please try again.", { status: 503 });
  }

  const download = new URL(request.url).searchParams.get("download") === "1";
  const filename = graphicFilename(sources.title, format);
  return new Response(Buffer.from(bytes), {
    headers: {
      "content-type": "image/jpeg",
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}
