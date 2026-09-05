import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { AppShell } from "@/components/app-shell";

/**
 * The chrome for every admin page. See `dashboard/layout.tsx` for why the
 * shell lives in the layout: loading skeletons render inside it, so the tabs
 * stay put and lit while a page streams in.
 *
 * Not the authorization boundary — each page re-checks the role itself.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role !== "admin") redirect("/dashboard");
  return <AppShell user={user}>{children}</AppShell>;
}
