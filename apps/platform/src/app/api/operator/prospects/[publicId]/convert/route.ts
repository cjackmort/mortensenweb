import { convertProspect, readConversion } from "@/db/repositories/admin/conversion";
import {
  handleOperatorRequest,
  OperatorApiError,
  publicIdParam,
  readJsonBody,
} from "@/lib/operator-api/http";
import { convertBody } from "@/lib/operator-api/schemas";

/**
 * `POST /api/operator/prospects/:id/convert` makes the potential client a
 * connected client; `GET` re-reads the last report.
 *
 * Authenticated by the operator API token (see `lib/operator-api/http.ts`).
 * Idempotent by step: a re-run repeats only what did not finish (see
 * `db/repositories/admin/conversion.ts`). The response is the report whether
 * or not every step succeeded — a failed step is information for the caller,
 * not a failed request — and it never carries a credential.
 */

export const dynamic = "force-dynamic";
// Seventeen steps, most of them a GitHub, Netlify or Umami call.
export const maxDuration = 60;

const CONVERSIONS_PER_HOUR = 30;
const HOUR_MS = 60 * 60_000;

type Params = { params: Promise<{ publicId: string }> };

export async function POST(request: Request, { params }: Params): Promise<Response> {
  return handleOperatorRequest(
    request,
    {
      action: "prospects.convert",
      quota: { auditAction: "prospect.conversion_run", limit: CONVERSIONS_PER_HOUR, windowMs: HOUR_MS },
    },
    async ({ ctx, db }) => {
      const prospectId = publicIdParam((await params).publicId);
      const body = await readJsonBody(request, convertBody);

      const outcome = await convertProspect(ctx, db, prospectId, { ...body, via: "operator-api" });
      if (!outcome.ok) {
        throw new OperatorApiError(
          409,
          "conversion_in_progress",
          "This potential client is being converted right now. GET this address for the report when it finishes.",
        );
      }

      return { status: 200, body: { ...outcome.report }, entity: { type: "prospect", id: prospectId } };
    },
  );
}

export async function GET(request: Request, { params }: Params): Promise<Response> {
  return handleOperatorRequest(request, { action: "prospects.convert.report" }, async ({ db }) => {
    const prospectId = publicIdParam((await params).publicId);
    const conversion = await readConversion(db, prospectId);
    return {
      status: 200,
      body: { state: conversion.state, report: conversion.report },
      entity: { type: "prospect", id: prospectId },
    };
  });
}
