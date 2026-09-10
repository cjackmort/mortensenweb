import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { storeUploadPart } from "@/db/repositories/client/media-uploads";
import { UPLOAD_PART_BYTES } from "@/lib/media/constants";
import { mediaFailureMessage } from "@/lib/media/errors";

/**
 * One part of one file.
 *
 * The body is raw bytes rather than multipart form data. Multipart would add a
 * boundary, headers and base64 framing to every part, all of it counting
 * against the same platform limit the parts exist to stay under — and it would
 * buy nothing, because there is exactly one field.
 *
 * `PUT` rather than `POST`, and that is not cosmetic: this is idempotent by
 * construction. `(upload_id, part_number)` is unique, so re-sending a part
 * overwrites one object and updates one row. A browser or proxy retrying a
 * request it was not sure completed cannot corrupt the assembled file, which is
 * what makes an interrupted upload safe to resume without any coordination.
 */

export const dynamic = "force-dynamic";

/**
 * One part is a single object-store write, so this is comfortably inside the
 * default — stated anyway so the whole upload path has a deliberate budget
 * rather than three different implicit ones.
 */
export const maxDuration = 30;

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ uploadId: string; partNumber: string }> },
): Promise<Response> {
  const user = await currentUser();
  if (!user?.organizationId) {
    return Response.json({ ok: false, message: "Please sign in again." }, { status: 401 });
  }

  const { uploadId, partNumber } = await params;
  const index = Number(partNumber);
  if (!Number.isInteger(index) || index < 1) {
    return Response.json({ ok: false, message: "Malformed request." }, { status: 400 });
  }

  const buffer = await request.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  if (bytes.byteLength === 0) {
    return Response.json({ ok: false, message: "That part was empty." }, { status: 400 });
  }
  // Checked here as well as in the repository so an oversized body is refused
  // before it is handed on. The platform would reject anything much larger
  // than this anyway; saying so ourselves gives a readable answer instead of
  // an opaque gateway error.
  if (bytes.byteLength > UPLOAD_PART_BYTES) {
    return Response.json(
      { ok: false, message: "That part was larger than expected." },
      { status: 413 },
    );
  }

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();

  try {
    const result = await storeUploadPart(db, ctx, uploadId, index, bytes);
    if (!result.ok) {
      return Response.json({ ok: false, message: result.message }, { status: 409 });
    }
    return Response.json(result);
  } catch (error) {
    // Another tenant's upload id, or one that does not exist. Indistinguishable
    // by design — a 403 would confirm the session exists.
    if (error instanceof NotFoundError) {
      return Response.json({ ok: false, message: "Not found." }, { status: 404 });
    }

    // Anything else used to be rethrown, which is how this route came to lie.
    //
    // An unhandled throw here renders Next's HTML error page. The uploader
    // cannot parse that, falls back to its generic message, and tells the
    // client "the connection dropped part-way" — a specific claim about their
    // network, made about a failure that happened entirely on the server. It
    // sends everyone, including whoever is debugging it, to the wrong place.
    //
    // The full error goes to the function log. What comes back names the step
    // that failed and nothing else: enough to tell a storage failure from a
    // database one without putting an exception in front of a client.
    console.error(
      `[media] part ${index} of upload ${uploadId} failed`,
      error instanceof Error ? error.stack ?? error.message : error,
    );

    return Response.json(
      {
        ok: false,
        message: mediaFailureMessage("save that part", error, user.role),
      },
      { status: 500 },
    );
  }
}
