import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { requireUsableGrowthFeature } from "@/db/repositories/client/growth";
import { listAssets } from "@/db/repositories/client/media-assets";
import { shopSiteFor } from "@/db/repositories/client/shop-settings";
import { MAX_PRODUCT_PHOTOS } from "@/lib/shop/products";
import { ProductForm } from "../product-form";
import { pickablePhotos, PICKER_LIMIT } from "../pickable";
import "../../shop.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Add a product",
  robots: { index: false, follow: false },
};

export default async function NewProductPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.organizationId) redirect("/dashboard");

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  if (!(await requireUsableGrowthFeature(db, ctx, "shop"))) redirect("/dashboard/growth?locked=shop#shop");
  if (!(await shopSiteFor(db, ctx))) redirect("/dashboard/growth/shop");

  const assets = await listAssets(db, ctx, { limit: PICKER_LIMIT });

  return (
    <main className="shell">
      <div className="masthead">
        <h1>Add a product</h1>
      </div>

      <ProductForm photos={pickablePhotos(assets)} maxPhotos={MAX_PRODUCT_PHOTOS} readOnly={ctx.impersonating} />
    </main>
  );
}
