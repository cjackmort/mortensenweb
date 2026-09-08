import { z } from "zod";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { beginUpload } from "@/db/repositories/client/media-uploads";
import { MAX_ORIGINAL_BYTES } from "@/lib/media/constants";

/**
 * Opening an upload session.
 *
 * A route handler rather than a server action, and that is the whole point of
 * this file existing. Server actions carry a body limit configured in
 * `next.config.ts`, and more importantly the *bytes* must not travel with the
 * request text at all — that coupling is what lost clients their typed requests
 * when a photo pushed the combined body past the platform's limit.
 *
 * Nothing binary crosses this endpoint. It exchanges a description of a file
 * for permission to send it, in parts, to the endpoint next door.
 */

export const dynamic = "force-dynamic";

const BeginSchema = z.object({
  filename: z.string().min(1).max(300),
  bytes: z.number().int().positive().max(MAX_ORIGINAL_BYTES),
  /** Computed by the browser over the whole file, before any part is sent. */
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
  contentType: z.string().max(100),
  folderPublicId: z.string().max(40).nullable().optional(),
});

export async function POST(request: Request): Promise<Response> {
  const user = await currentUser();
  if (!user?.organizationId) {
    return Response.json({ ok: false, message: "Please sign in again." }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ ok: false, message: "Malformed request." }, { status: 400 });
  }

  const parsed = BeginSchema.safeParse(payload);
  if (!parsed.success) {
    // Deliberately not echoing the validation detail. It describes our schema,
    // and the client's UI already knows what it is allowed to send.
    return Response.json(
      { ok: false, message: "That file could not be accepted." },
      { status: 400 },
    );
  }

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();

  const result = await beginUpload(db, ctx, {
    filename: parsed.data.filename,
    declaredBytes: parsed.data.bytes,
    declaredChecksum: parsed.data.checksum,
    declaredContentType: parsed.data.contentType,
    folderPublicId: parsed.data.folderPublicId ?? null,
  });

  if (!result.ok) {
    // 413 for size, 507 for quota, 400 for anything malformed. Distinct codes
    // because the browser retries differently: a size refusal is final, a quota
    // refusal becomes actionable once the client empties their trash.
    const status =
      result.reason === "too_large" ? 413 : result.reason === "quota" ? 507 : 400;
    return Response.json({ ok: false, message: result.message }, { status });
  }

  return Response.json(result, { status: 201 });
}
