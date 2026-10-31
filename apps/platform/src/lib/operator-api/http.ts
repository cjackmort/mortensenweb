import { NextResponse } from "next/server";
import { and, count, eq, gte } from "drizzle-orm";
import type { z } from "zod";
import { getDb, type Database } from "@/db/client";
import { auditLog } from "@/db/schema";
import {
  adminContextFromOperatorGrant,
  NotFoundError,
  type AdminContext,
  type OperatorApiGrant,
} from "@/db/repositories/context";
import { ensureOperatorActor } from "@/db/repositories/admin/operator-actor";
import { checkOperatorToken } from "@/lib/auth/operator-token";
import { ipFromHeaders } from "@/lib/auth/client-ip";
import { sha256Hex } from "@/lib/auth/password";
import { newPublicId } from "@/lib/ids";
import { createRateLimiter } from "@/lib/reviews/rate-limit";

/**
 * What every `/api/operator/*` route does before and after its own work.
 *
 * In order: a per-address limit, the token, the system actor, a per-hour quota
 * for actions that create things outside the portal, the handler, and one
 * audit row naming what was asked and how it ended.
 *
 * A refused token never reaches the database. The refusal is logged with the
 * request id and a hash of the address, and nothing is written: an endpoint
 * that wrote a row for every bad guess would let anyone keep Neon awake (see
 * the root CLAUDE.md) and fill the audit log. Every call that *is* the
 * operator is audit-logged, whatever its outcome.
 *
 * Errors are JSON with a stable `code` and a message written for the caller.
 * An unexpected exception becomes a 500 with the request id and nothing else;
 * the stack goes to the server log under the same id.
 */

/** Per address, before the token is looked at. Far above what one agent does. */
export const REQUESTS_PER_MINUTE_PER_ADDRESS = 60;
/** Authenticated calls per instance. A runaway loop stops here, cheaply. */
export const OPERATOR_CALLS_PER_MINUTE = 30;
/** Bodies are a handful of fields; anything larger is not one of ours. */
export const MAX_BODY_BYTES = 32 * 1024;

const addressLimiter = createRateLimiter({
  limit: REQUESTS_PER_MINUTE_PER_ADDRESS,
  windowMs: 60_000,
});
const operatorLimiter = createRateLimiter({ limit: OPERATOR_CALLS_PER_MINUTE, windowMs: 60_000 });

const PUBLIC_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export class OperatorApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "OperatorApiError";
  }
}

export interface OperatorCall {
  ctx: AdminContext;
  db: Database;
  requestId: string;
}

export interface OperatorResult {
  status: number;
  body: Record<string, unknown>;
  /** The record the call acted on, for the audit row. */
  entity?: { type: string; id: string };
}

/**
 * A ceiling counted from the audit log, so it holds across function instances
 * and cold starts — unlike the in-memory limits, which a new instance resets.
 * For the calls that create GitHub repositories and Netlify sites.
 */
export interface Quota {
  auditAction: string;
  limit: number;
  windowMs: number;
}

export interface OperatorRouteOptions {
  /** Names the call in the audit row, e.g. `prospects.create`. */
  action: string;
  quota?: Quota;
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  details?: unknown,
): Response {
  return NextResponse.json(
    { error: { code, message, ...(details ? { details } : {}) }, requestId },
    {
      status,
      headers: {
        "X-Request-Id": requestId,
        ...(status === 401 ? { "WWW-Authenticate": "Bearer" } : {}),
      },
    },
  );
}

export async function handleOperatorRequest(
  request: Request,
  options: OperatorRouteOptions,
  handler: (call: OperatorCall) => Promise<OperatorResult>,
): Promise<Response> {
  const requestId = newPublicId();
  const ip = ipFromHeaders(request.headers);

  // A request with no address is let through, as on the review links: one
  // shared fallback key would throttle every such caller together, and the
  // token is the control that holds regardless.
  if (ip && !addressLimiter.allow(ip)) {
    return errorResponse(429, "rate_limited", "Too many requests. Wait a minute and try again.", requestId);
  }

  const token = await checkOperatorToken(request.headers);
  if (token !== "ok") {
    console.warn("[operator-api] refused", {
      requestId,
      reason: token,
      action: options.action,
      ipHash: ip ? (await sha256Hex(ip)).slice(0, 16) : null,
    });
    return errorResponse(401, "unauthorized", "A valid operator API token is required.", requestId);
  }

  if (!operatorLimiter.allow("operator")) {
    return errorResponse(429, "rate_limited", "Too many operator calls. Wait a minute and try again.", requestId);
  }

  let db: Database;
  let ctx: AdminContext;
  try {
    db = await getDb();
    const actorUserId = await ensureOperatorActor(db);
    ctx = adminContextFromOperatorGrant({ actorUserId } as OperatorApiGrant);
  } catch (error) {
    console.error("[operator-api] could not establish the actor", { requestId, error });
    return errorResponse(
      503,
      "unavailable",
      "The operator API is unavailable. The portal's log has the details under this request id.",
      requestId,
    );
  }

  let response: Response;
  let outcome: { status: number; code: string; entity?: OperatorResult["entity"] };

  try {
    if (options.quota && (await overQuota(db, ctx, options.quota))) {
      throw new OperatorApiError(
        429,
        "quota_exceeded",
        `At most ${options.quota.limit} of these an hour. Try again later.`,
      );
    }

    const result = await handler({ ctx, db, requestId });
    response = NextResponse.json(
      { ...result.body, requestId },
      { status: result.status, headers: { "X-Request-Id": requestId } },
    );
    outcome = { status: result.status, code: "ok", entity: result.entity };
  } catch (error) {
    if (error instanceof OperatorApiError) {
      response = errorResponse(error.status, error.code, error.message, requestId, error.details);
      outcome = { status: error.status, code: error.code };
    } else if (error instanceof NotFoundError) {
      // Absent and archived read the same, as everywhere else in the portal.
      response = errorResponse(404, "not_found", "No such record.", requestId);
      outcome = { status: 404, code: "not_found" };
    } else {
      console.error("[operator-api] handler failed", { requestId, action: options.action, error });
      response = errorResponse(
        500,
        "internal",
        "Something went wrong. The portal's log has the details under this request id.",
        requestId,
      );
      outcome = { status: 500, code: "internal" };
    }
  }

  await recordCall(db, ctx, request, { requestId, ip, action: options.action, ...outcome });
  return response;
}

async function overQuota(db: Database, ctx: AdminContext, quota: Quota): Promise<boolean> {
  const since = new Date(Date.now() - quota.windowMs);
  const [row] = await db
    .select({ n: count() })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, quota.auditAction),
        eq(auditLog.actorUserId, ctx.userId),
        gte(auditLog.createdAt, since),
      ),
    );
  return (row?.n ?? 0) >= quota.limit;
}

async function recordCall(
  db: Database,
  ctx: AdminContext,
  request: Request,
  call: {
    requestId: string;
    ip: string | undefined;
    action: string;
    status: number;
    code: string;
    entity?: { type: string; id: string };
  },
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      actorUserId: ctx.userId,
      action: "operator_api.call",
      entityType: call.entity?.type ?? "operator_api",
      entityId: call.entity?.id ?? null,
      ipHash: call.ip ? await sha256Hex(call.ip) : null,
      metadata: {
        via: "operator-api",
        requestId: call.requestId,
        call: call.action,
        method: request.method,
        path: new URL(request.url).pathname,
        status: call.status,
        outcome: call.code,
      },
    });
  } catch (error) {
    // The work is done and its own rows are written; the response still goes
    // out. Loudly, because an unlogged operator call is exactly what this row
    // exists to prevent.
    console.error("[operator-api] AUDIT ROW NOT WRITTEN", { ...call, error });
  }
}

/** A public id from the path, refused before it reaches a query. */
export function publicIdParam(value: string): string {
  const id = value.trim().toUpperCase();
  if (!PUBLIC_ID.test(id)) throw new NotFoundError();
  return id;
}

/**
 * Read and validate a JSON body. An empty body is `{}`, so a call whose fields
 * are all optional can be made with none.
 */
export async function readJsonBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.infer<S>> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    throw new OperatorApiError(413, "too_large", "The request body is too large.");
  }

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new OperatorApiError(413, "too_large", "The request body is too large.");
  }

  let raw: unknown = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new OperatorApiError(400, "invalid_json", "The request body is not valid JSON.");
    }
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new OperatorApiError(
      400,
      "invalid_request",
      "The request body did not validate.",
      parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}
