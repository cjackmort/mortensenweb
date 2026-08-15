/**
 * Access contexts.
 *
 * This module is the tenant isolation boundary. The guarantee it provides is
 * structural rather than advisory:
 *
 *  1. `TenantContext` and `AdminContext` are *branded* types. TypeScript will
 *     not accept an object literal in their place, so a caller cannot invent a
 *     context with an arbitrary `organizationId`.
 *  2. The only constructors live here and both require a verified session.
 *  3. Client-facing repositories take a `TenantContext` as their first
 *     argument and add `where org_id = ctx.organizationId` to every query.
 *  4. Admin repositories take an `AdminContext` and live in a separate
 *     directory, so a client route cannot import a cross-tenant query even by
 *     accident.
 *
 * Reviewing for isolation therefore means reviewing this file plus the two
 * repository directories, not every route in the application.
 */

declare const contextBrand: unique symbol;

export interface SessionLike {
  userId: string;
  organizationId: string | null;
  role: "admin" | "client";
  status: "invited" | "active" | "disabled";
  sessionEpoch: number;
}

/** Scoped to exactly one organization. Cannot be widened. */
export interface TenantContext {
  readonly [contextBrand]: "tenant";
  readonly userId: string;
  readonly organizationId: string;
  readonly role: "admin" | "client";
  /** True while an admin is viewing as a client: all mutations are refused. */
  readonly impersonating: boolean;
}

/** Unscoped. Only obtainable by an active admin. */
export interface AdminContext {
  readonly [contextBrand]: "admin";
  readonly userId: string;
}

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

/**
 * Thrown when a record is absent *or* belongs to another tenant.
 *
 * These two cases are deliberately indistinguishable. Routes render this as
 * **404, never 403** — a 403 confirms the record exists, which is itself a
 * cross-tenant information leak.
 */
export class NotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

/**
 * Build a tenant context from a verified session.
 *
 * @param session   Session already validated against the database, including
 *                  the `sessionEpoch` check.
 * @param organizationId The organization being accessed. For a client this
 *                  must equal their own organization; an admin may pass any,
 *                  which is how "view as client" works.
 */
export function tenantContextFrom(
  session: SessionLike,
  organizationId: string,
  options: { impersonating?: boolean } = {},
): TenantContext {
  if (session.status !== "active") {
    throw new AuthorizationError("Account is not active.");
  }
  if (session.role !== "admin" && session.organizationId !== organizationId) {
    // A client reaching for another tenant is not told it exists.
    throw new NotFoundError();
  }
  return {
    userId: session.userId,
    organizationId,
    role: session.role,
    impersonating: options.impersonating ?? false,
  } as TenantContext;
}

/** Build an admin context. Refuses any non-admin session. */
export function adminContextFrom(session: SessionLike): AdminContext {
  if (session.status !== "active") {
    throw new AuthorizationError("Account is not active.");
  }
  if (session.role !== "admin") {
    throw new AuthorizationError("Admin role required.");
  }
  return { userId: session.userId } as AdminContext;
}

/**
 * Guard for mutations. Impersonation ("view as client") is strictly read-only,
 * so every write path calls this first.
 */
export function assertMutable(ctx: TenantContext): void {
  if (ctx.impersonating) {
    throw new AuthorizationError(
      "This session is impersonating a client and is read-only.",
    );
  }
}
