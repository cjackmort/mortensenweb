"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { confirmDomainAccess } from "@/db/repositories/client/domain";

/** "Done, I've given you access". The tenant comes from the session, never the form. */

export type DomainResult = { ok: boolean; message: string };

export async function confirmDomainAction(_previous: DomainResult | null, form: FormData): Promise<DomainResult> {
  const user = await currentUser();
  if (!user?.organizationId || user.role !== "client") return { ok: false, message: "Please sign in again." };

  const result = await confirmDomainAccess(await getDb(), tenantContextFrom(user, user.organizationId), {
    domain: String(form.get("domain") ?? "").slice(0, 253),
    registrar: String(form.get("registrar") ?? "").slice(0, 32),
  });
  if (result.ok) revalidatePath("/dashboard/domain");
  return result;
}
