import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { readOwnAvatar } from "@/db/repositories/client/profile";

/**
 * The signed-in person's own profile picture.
 *
 * Only their own: the route reads the session, never a parameter, so there
 * is no id to guess. The bytes were written by `prepareAvatar`, which only
 * ever encodes what sharp decoded, and are served with `nosniff` and a
 * sandboxing CSP regardless — it is still an upload on the portal's origin.
 *
 * Cached privately for a day. The key, and so the `?v=` in every URL that
 * points here, changes on each upload, so a new picture is fetched at once.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const user = await currentUser();
  if (!user?.organizationId) return new Response(null, { status: 404 });

  let avatar;
  try {
    avatar = await readOwnAvatar(await getDb(), tenantContextFrom(user, user.organizationId));
  } catch (error) {
    console.error("[profile] avatar read failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return new Response(null, { status: 503 });
  }
  if (!avatar) return new Response(null, { status: 404 });

  return new Response(Buffer.from(avatar.bytes), {
    headers: {
      "content-type": avatar.contentType,
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}
