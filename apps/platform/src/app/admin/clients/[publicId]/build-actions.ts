"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom, NotFoundError } from "@/db/repositories/context";
import { setClientBuild } from "@/db/repositories/admin/client-build";

/** Which build a client's cart charges, at what price. Admin only, re-checked here. */

export type BuildFormResult = { ok: boolean; message: string };

export async function setBuildAction(_previous: BuildFormResult | null, form: FormData): Promise<BuildFormResult> {
  const user = await currentUser();
  if (!user || user.role !== "admin") throw new NotFoundError();
  const clientPublicId = String(form.get("clientPublicId") ?? "");

  const result = await setClientBuild(adminContextFrom(user), await getDb(), {
    clientPublicId,
    buildKey: String(form.get("buildKey") ?? ""),
    price: String(form.get("price") ?? ""),
  });
  if (result.ok) revalidatePath(`/admin/clients/${clientPublicId}`);
  return result;
}
