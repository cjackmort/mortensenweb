import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { requireGrowthFeature } from "@/db/repositories/client/growth";
import { listCampaignSites } from "@/db/repositories/client/campaigns";
import { CreateCampaignForm } from "../campaign-forms";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "New campaign",
  robots: { index: false, follow: false },
};

export default async function NewCampaignPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.organizationId) redirect("/dashboard");

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  if (!(await requireGrowthFeature(db, ctx, "campaigns"))) redirect("/dashboard/growth?locked=campaigns#campaigns");
  const sites = await listCampaignSites(db, ctx);

  return (
    <main className="shell">
      <div className="masthead">
        <h1>New campaign</h1>
      </div>

      <section className="panel">
        <div className="panel-body">
          <p className="panel-note">
            One campaign for each thing you print. You get a QR code and a short link to put on it, and every scan
            is counted here.
          </p>
          <CreateCampaignForm sites={sites} readOnly={ctx.impersonating} />
        </div>
      </section>
    </main>
  );
}
