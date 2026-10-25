import { cookies } from "next/headers";
import { signedInUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import { CLIENT_VIEW_MAX_HOURS, endClientView } from "@/db/repositories/admin/client-view";
import { clientViewCookieName } from "./cookie-name";

/**
 * The browser's half of "Switch to MortensenWeb": a cookie holding the
 * switch's public id. Only server actions write it; `currentUser()` reads it.
 */

export function clientViewCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: CLIENT_VIEW_MAX_HOURS * 60 * 60,
  };
}

/**
 * End any open switch and forget the cookie. Called on switching back and on
 * signing out, so the next sign-in in this browser starts as the admin.
 *
 * Asks for the signed-in account rather than `currentUser()`: while switched,
 * `currentUser()` is the client, and ending the switch needs the admin.
 */
export async function closeClientView(): Promise<void> {
  const jar = await cookies();
  const sessionPublicId = jar.get(clientViewCookieName())?.value;
  if (!sessionPublicId) return;

  jar.delete(clientViewCookieName());
  const admin = await signedInUser();
  if (admin?.role !== "admin") return;
  await endClientView(adminContextFrom(admin), await getDb(), sessionPublicId);
}
