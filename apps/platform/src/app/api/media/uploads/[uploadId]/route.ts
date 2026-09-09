import { after } from "next/server";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import {
  abortUpload,
  completeUpload,
  receivedPartNumbers,
} from "@/db/repositories/client/media-uploads";
import { runDerivativeJobs } from "@/db/repositories/admin/media-jobs";

/**
 * Finishing, resuming, or giving up on an upload.
 *
 *  - `GET` reports which parts the server actually holds. A browser resuming
 *    after a reload asks this and sends only what is missing, which is the
 *    difference between re-uploading 40 MB and re-uploading 3.
 *  - `POST` completes: the server assembles, verifies the checksum, sniffs the
 *    format, and only then admits the asset. Safe to call twice.
 *  - `DELETE` abandons the session and releases the quota it held.
 */

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ uploadId: string }> },
): Promise<Response> {
  const user = await currentUser();
  if (!user?.organizationId) {
    return Response.json({ ok: false, message: "Please sign in again." }, { status: 401 });
  }

  const { uploadId } = await params;
  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();

  try {
    return Response.json({ ok: true, receivedParts: await receivedPartNumbers(db, ctx, uploadId) });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return Response.json({ ok: false, message: "Not found." }, { status: 404 });
    }
    throw error;
  }
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ uploadId: string }> },
): Promise<Response> {
  const user = await currentUser();
  if (!user?.organizationId) {
    return Response.json({ ok: false, message: "Please sign in again." }, { status: 401 });
  }

  const { uploadId } = await params;
  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();

  try {
    const result = await completeUpload(db, ctx, uploadId);
    if (!result.ok) {
      // 409 when resending the missing parts would fix it, 422 when nothing the
      // client does to this file will. The browser branches on exactly that:
      // one offers Retry, the other explains and offers Remove.
      return Response.json(
        { ok: false, message: result.message, retryable: result.retryable },
        { status: result.retryable ? 409 : 422 },
      );
    }

    // Derivatives are queued, not run inline — putting image processing in the
    // request a person is waiting on is the mistake this whole design exists to
    // undo. `after()` gives the queue a nudge once the response has gone, so
    // the usual wait is seconds rather than the next scheduled tick.
    after(async () => {
      try {
        await runDerivativeJobs(await getDb(), 2);
      } catch (error) {
        console.warn("[media] derivative nudge failed", {
          message: error instanceof Error ? error.message : "unknown",
        });
      }
    });

    return Response.json(result);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return Response.json({ ok: false, message: "Not found." }, { status: 404 });
    }
    throw error;
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ uploadId: string }> },
): Promise<Response> {
  const user = await currentUser();
  if (!user?.organizationId) {
    return Response.json({ ok: false, message: "Please sign in again." }, { status: 401 });
  }

  const { uploadId } = await params;
  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();

  try {
    await abortUpload(db, ctx, uploadId);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return Response.json({ ok: false, message: "Not found." }, { status: 404 });
    }
    throw error;
  }
}
