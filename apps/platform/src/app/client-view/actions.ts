"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import { startClientView } from "@/db/repositories/admin/client-view";
import { clientIpAddress } from "@/lib/auth/client-ip";
import { clientViewCookieName } from "@/lib/auth/cookie-name";
import { clientViewCookieOptions, closeClientView } from "@/lib/auth/client-view-cookie";
import { sha256Hex } from "@/lib/auth/password";

/**
 * The two buttons in the top bar: "Switch to MortensenWeb" for an admin, and
 * "Back to admin" while switched. See `db/repositories/admin/client-view.ts`.
 */

export async function switchToMortensenWeb(): Promise<void> {
  const user = await currentUser();
  if (!user) redirect("/login");
  // Already switched, or a client who somehow posted this: nothing to start.
  if (user.role !== "admin") redirect("/dashboard");

  const ip = await clientIpAddress();
  const view = await startClientView(adminContextFrom(user), await getDb(), {
    ipHash: ip ? await sha256Hex(ip) : null,
  });
  // No record is marked as the agency's own. The MortensenWeb tab says how to link one.
  if (!view) redirect("/admin/mortensenweb");

  (await cookies()).set(clientViewCookieName(), view.sessionPublicId, clientViewCookieOptions());
  redirect("/dashboard");
}

export async function switchBackToAdmin(): Promise<void> {
  const user = await currentUser();
  if (!user) redirect("/login");

  await closeClientView();
  redirect("/admin");
}
