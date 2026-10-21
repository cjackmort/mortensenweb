/**
 * What went wrong talking to Google, in the terms the portal acts on.
 *
 * Google's APIs answer failures as `{ error: { code, message, status,
 * details[] } }`. The portal does not care about most of that; it needs to
 * know which of a handful of things to do next:
 *
 *  - `quota` — 429 / RESOURCE_EXHAUSTED. Stop every sync until the pause
 *    ends. An unapproved Business Profile project has a quota of zero, so this
 *    is also what "access not approved yet" looks like.
 *  - `auth` — the access token or refresh token is no good. Reconnect.
 *  - `api_disabled` — one of the APIs is not enabled in the Cloud project.
 *  - `permission` — the account cannot see or edit that profile (usually: the
 *    client has not added the agency as a manager, or removed it).
 *  - `not_found`, `invalid` — a bad location, or Google refused the edit.
 *  - `unavailable` — Google or the network failed; retry later with backoff.
 */

export type GoogleErrorKind =
  | "quota"
  | "auth"
  | "api_disabled"
  | "permission"
  | "not_found"
  | "invalid"
  | "unavailable";

export class GoogleApiError extends Error {
  readonly kind: GoogleErrorKind;
  readonly status: number;
  /** Seconds Google asked us to wait, when it said. */
  readonly retryAfterSeconds: number | null;

  constructor(kind: GoogleErrorKind, status: number, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "GoogleApiError";
    this.kind = kind;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface GoogleErrorBody {
  error?:
    | string
    | {
        code?: number;
        message?: string;
        status?: string;
        details?: Array<{ reason?: string; "@type"?: string }>;
      };
  error_description?: string;
}

function reasonsOf(body: GoogleErrorBody): string[] {
  if (!body.error || typeof body.error === "string") return [];
  return (body.error.details ?? []).map((d) => d.reason ?? "").filter(Boolean);
}

function retryAfter(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/** Turn a failed Google response into a `GoogleApiError`. Never throws itself. */
export async function errorFromResponse(response: Response): Promise<GoogleApiError> {
  let body: GoogleErrorBody = {};
  try {
    body = (await response.json()) as GoogleErrorBody;
  } catch {
    // An HTML error page from a proxy, or nothing at all.
  }

  const status = response.status;
  const statusName = typeof body.error === "object" ? (body.error.status ?? "") : "";
  const oauthError = typeof body.error === "string" ? body.error : null;
  const message =
    (typeof body.error === "object" ? body.error.message : null) ??
    body.error_description ??
    oauthError ??
    `Google answered ${status}.`;
  const reasons = reasonsOf(body);

  if (status === 429 || statusName === "RESOURCE_EXHAUSTED") {
    return new GoogleApiError("quota", status, message, retryAfter(response.headers));
  }
  if (status === 401 || oauthError === "invalid_grant" || oauthError === "invalid_client") {
    return new GoogleApiError("auth", status, message);
  }
  if (status === 403) {
    if (reasons.includes("SERVICE_DISABLED") || /has not been used|is disabled/i.test(message)) {
      return new GoogleApiError("api_disabled", status, message);
    }
    if (reasons.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT")) {
      return new GoogleApiError("auth", status, message);
    }
    return new GoogleApiError("permission", status, message);
  }
  if (status === 404) return new GoogleApiError("not_found", status, message);
  if (status === 400 || status === 409 || status === 412) {
    return new GoogleApiError("invalid", status, message);
  }
  return new GoogleApiError("unavailable", status, message, retryAfter(response.headers));
}

/** The operator-facing sentence for a failure. Short; the raw message goes to the log. */
export function describeGoogleError(error: unknown): string {
  if (!(error instanceof GoogleApiError)) {
    return "Google could not be reached. It will be retried.";
  }
  switch (error.kind) {
    case "quota":
      return "Google is limiting requests (quota). Syncing pauses and resumes on its own. If this never clears, the Business Profile API access request has not been approved yet.";
    case "auth":
      return "Google no longer accepts the agency's sign-in. Reconnect the Google account.";
    case "api_disabled":
      return "One of the Business Profile APIs is not enabled in the Google Cloud project.";
    case "permission":
      return "The agency's Google account cannot manage this profile. Ask the client to add it as a Manager.";
    case "not_found":
      return "Google cannot find this profile. It may have been removed, or linked to the wrong location.";
    case "invalid":
      return `Google refused the change: ${error.message}`;
    case "unavailable":
      return "Google did not answer. It will be retried.";
  }
}
