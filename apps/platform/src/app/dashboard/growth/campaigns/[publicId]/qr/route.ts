import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { requireGrowthFeature } from "@/db/repositories/client/growth";
import { getCampaign } from "@/db/repositories/client/campaigns";
import { qrPng, qrSvg } from "@/lib/campaigns/qr";

/**
 * A campaign's QR code as a file: `?format=svg` for a printer, `?format=png`
 * for anything that will not take a vector.
 *
 * Behind the session like the page it is linked from. The code itself is
 * not secret — it is printed on paper — but which campaigns a client runs
 * is their business.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ publicId: string }> }) {
  const user = await currentUser();
  if (!user?.organizationId) return new Response("Not found", { status: 404 });

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  if (!(await requireGrowthFeature(db, ctx, "campaigns"))) return new Response("Not found", { status: 404 });

  let campaign;
  try {
    campaign = await getCampaign(db, ctx, (await params).publicId);
  } catch (error) {
    if (error instanceof NotFoundError) return new Response("Not found", { status: 404 });
    throw error;
  }

  const format = new URL(request.url).searchParams.get("format") === "png" ? "png" : "svg";
  const filename = `${campaign.utmCampaign}-qr.${format}`;
  const headers = {
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
  };

  if (format === "png") {
    const png = await qrPng(campaign.shortLink);
    return new Response(new Uint8Array(png), { headers: { ...headers, "Content-Type": "image/png" } });
  }
  return new Response(qrSvg(campaign.shortLink), {
    headers: { ...headers, "Content-Type": "image/svg+xml; charset=utf-8" },
  });
}
