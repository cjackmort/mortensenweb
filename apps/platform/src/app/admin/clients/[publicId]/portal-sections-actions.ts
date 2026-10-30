"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import { setClientSections } from "@/db/repositories/admin/clients";

export type PortalSectionsResult = { ok: boolean; message: string };

/** What the portal shows them now, in words, for the confirmation. */
function described(booking: boolean, shop: boolean): string {
  if (booking && shop) return "Their portal now has the Availability and Shop tabs.";
  if (booking) return "Their portal now has the Availability tab, and no Shop tab.";
  if (shop) return "Their portal now has the Shop tab, and no Availability tab.";
  return "Their portal now has neither the Availability nor the Shop tab.";
}

/**
 * Change what kind of site a client has. Admin only, re-checked here: a
 * server action is a public POST endpoint, and the page not rendering the
 * form for anyone else is no defence. Audited in `setClientSections`.
 */
export async function setPortalSectionsAction(
  _previous: PortalSectionsResult | null,
  formData: FormData,
): Promise<PortalSectionsResult> {
  const user = await currentUser();
  if (!user || user.role !== "admin") {
    return { ok: false, message: "Only an admin can do that." };
  }

  const clientPublicId = String(formData.get("clientPublicId") ?? "").trim();
  if (!clientPublicId) return { ok: false, message: "No client specified." };

  const bookingEnabled = formData.get("bookingEnabled") === "on";
  const shopEnabled = formData.get("shopEnabled") === "on";

  let outcome;
  try {
    outcome = await setClientSections(adminContextFrom(user), await getDb(), clientPublicId, {
      bookingEnabled,
      shopEnabled,
    });
  } catch (error) {
    console.error("[admin] portal sections change failed", {
      client: clientPublicId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return { ok: false, message: "That did not save. Nothing changed; please try again." };
  }

  if (!outcome.ok) return { ok: false, message: "No such client." };
  if (!outcome.changed) return { ok: true, message: "Nothing to change. " + described(bookingEnabled, shopEnabled) };

  revalidatePath(`/admin/clients/${clientPublicId}`);
  return { ok: true, message: `Saved. ${described(bookingEnabled, shopEnabled)}` };
}
