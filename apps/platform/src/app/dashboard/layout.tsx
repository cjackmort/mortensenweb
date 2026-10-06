import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { AppShell } from "@/components/app-shell";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { countUnreadLeads } from "@/db/repositories/client/leads";

/**
 * The chrome for every client page, rendered once by the layout rather than
 * by each page.
 *
 * Two reasons. First, a route's `loading.tsx` renders *inside* its layout, so
 * with the shell here the top bar and tabs are on screen while a page is
 * still loading — a tap on a tab now shows the tab lit and the page's
 * skeleton, instead of a frozen screen. Second, one place decides what a
 * client sees around their pages.
 *
 * This is not the authorization boundary. Every page still calls
 * `currentUser()` and gates itself; `currentUser` is request-cached, so the
 * layout's call and the page's call cost one database read between them.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role === "admin") redirect("/admin");

  // One indexed count per page view. A failure loses the badge, never the
  // page: the inbox itself is one tap away and shows the truth.
  let unreadLeads = 0;
  if (user.organizationId) {
    try {
      unreadLeads = await countUnreadLeads(
        await getDb(),
        tenantContextFrom(user, user.organizationId),
      );
    } catch (error) {
      console.error("[dashboard] unread lead count failed", error);
    }
  }

  return (
    <AppShell user={user} unreadLeads={unreadLeads}>
      {children}
    </AppShell>
  );
}
