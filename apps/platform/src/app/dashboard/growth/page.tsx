import { redirect } from "next/navigation";

/**
 * The Growth tab. Leads are its only section so far, so the tab opens them
 * directly; this becomes an overview — the monthly report and the add-on's
 * tools — as those are built. See `docs/growth-plan.md`.
 */
export default function GrowthPage() {
  redirect("/dashboard/growth/leads");
}
