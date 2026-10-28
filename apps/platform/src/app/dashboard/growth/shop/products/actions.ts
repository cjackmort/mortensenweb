"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { requireUsableGrowthFeature } from "@/db/repositories/client/growth";
import {
  createProduct,
  deleteProduct,
  setProductStatus,
  updateProduct,
  type ProductResult,
} from "@/db/repositories/client/shop-products";

/**
 * Product mutations. Each re-derives the tenant from the session — a server
 * action is a public POST endpoint — and looks the product up inside the
 * caller's own organization only. Each re-checks the feature, because a
 * locked page does not stop a POST.
 */

export type ProductActionResult = { ok: true; message: string } | { ok: false; message: string };

const SIGN_IN_AGAIN: ProductActionResult = { ok: false, message: "Please sign in again." };
const NOT_IN_PLAN: ProductActionResult = { ok: false, message: "Your plan does not include the shop. See Growth to add it." };
const GONE: ProductActionResult = { ok: false, message: "That product no longer exists." };

async function context() {
  const user = await currentUser();
  if (!user?.organizationId || user.role !== "client") return null;
  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  if (!(await requireUsableGrowthFeature(db, ctx, "shop"))) return "locked" as const;
  return { ctx, db };
}

function refresh(publicId?: string) {
  revalidatePath("/dashboard/growth/shop");
  if (publicId) revalidatePath(`/dashboard/growth/shop/products/${publicId}`);
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "");

function productInput(form: FormData) {
  return {
    name: text(form, "name"),
    description: text(form, "description"),
    price: text(form, "price"),
    stock: text(form, "stock"),
    photoPublicIds: form.getAll("photo").map(String),
  };
}

/** Catches a product that is not the caller's and answers as if it never existed. */
async function guarded(run: () => Promise<ProductResult>): Promise<ProductResult | ProductActionResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof NotFoundError) return GONE;
    throw error;
  }
}

export async function createProductAction(_previous: ProductActionResult | null, form: FormData): Promise<ProductActionResult> {
  const s = await context();
  if (!s) return SIGN_IN_AGAIN;
  if (s === "locked") return NOT_IN_PLAN;

  const result = await createProduct(s.db, s.ctx, productInput(form));
  if (!result.ok) return result;
  refresh();
  redirect(`/dashboard/growth/shop/products/${result.publicId}?added=1`);
}

export async function updateProductAction(_previous: ProductActionResult | null, form: FormData): Promise<ProductActionResult> {
  const s = await context();
  if (!s) return SIGN_IN_AGAIN;
  if (s === "locked") return NOT_IN_PLAN;

  const publicId = text(form, "product");
  const result = await guarded(() => updateProduct(s.db, s.ctx, publicId, productInput(form)));
  if (result.ok) refresh(publicId);
  return { ok: result.ok, message: result.message };
}

export async function setProductStatusAction(_previous: ProductActionResult | null, form: FormData): Promise<ProductActionResult> {
  const s = await context();
  if (!s) return SIGN_IN_AGAIN;
  if (s === "locked") return NOT_IN_PLAN;

  const publicId = text(form, "product");
  const status = text(form, "status") === "active" ? "active" : "hidden";
  const result = await guarded(() => setProductStatus(s.db, s.ctx, publicId, status));
  if (result.ok) refresh(publicId);
  return { ok: result.ok, message: result.message };
}

export async function deleteProductAction(_previous: ProductActionResult | null, form: FormData): Promise<ProductActionResult> {
  const s = await context();
  if (!s) return SIGN_IN_AGAIN;
  if (s === "locked") return NOT_IN_PLAN;

  const publicId = text(form, "product");
  const result = await guarded(() => deleteProduct(s.db, s.ctx, publicId));
  if (!result.ok) return result;
  refresh(publicId);
  redirect("/dashboard/growth/shop?deleted=1");
}
