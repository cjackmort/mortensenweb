import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { users } from "@/db/schema";
import { newPublicId } from "@/lib/ids";

/**
 * The user the operator API acts as.
 *
 * Every repository function records `ctx.userId` — in the audit log, as a
 * brief's author, as the person who converted a prospect — and those columns
 * reference `users`. A call made with the API token has no person behind it,
 * so it gets one system user, and the audit trail says "Operator API" rather
 * than crediting whichever admin owns the token.
 *
 * The row can never sign in, and that is enforced by three things already in
 * place rather than by anything new: `status` is `disabled`, which both
 * `authenticate` and `resolveSession` refuse; there is no password hash; and
 * the address is on `.invalid`, a top-level domain reserved never to resolve,
 * so a password reset for it has nowhere to go (and refuses a disabled
 * account anyway).
 *
 * Created on first use rather than by a migration: it is data, not schema,
 * and an environment that never enables the API never has the row.
 */

export const OPERATOR_API_ACTOR_EMAIL = "operator-api@portal.invalid";
export const OPERATOR_API_ACTOR_NAME = "Operator API";

export async function ensureOperatorActor(db: Database): Promise<string> {
  const existing = await findActor(db);
  if (existing) return existing;

  // Two first calls at once both reach here; the unique email index lets one
  // insert win and the other read it back.
  await db
    .insert(users)
    .values({
      publicId: newPublicId(),
      email: OPERATOR_API_ACTOR_EMAIL,
      name: OPERATOR_API_ACTOR_NAME,
      role: "admin",
      status: "disabled",
    })
    .onConflictDoNothing({ target: users.email });

  const created = await findActor(db);
  if (!created) throw new Error("The operator API's system user could not be created.");
  return created;
}

async function findActor(db: Database): Promise<string | null> {
  const rows = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.email, OPERATOR_API_ACTOR_EMAIL))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  // Somebody activated it by hand. An account that can sign in must not be
  // the API's identity, so refuse rather than act as it.
  if (row.status !== "disabled") {
    throw new Error("The operator API's system user is not disabled; refusing to act as it.");
  }
  return row.id;
}
