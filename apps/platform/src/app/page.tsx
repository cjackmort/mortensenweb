import { redirect } from "next/navigation";
import { currentUser } from "@/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await currentUser();
  if (!user) redirect("/login");
  // An emailed temporary credential gets no further than this.
  if (user.mustChangePassword) redirect("/change-password");
  redirect(user.role === "admin" ? "/admin" : "/dashboard");
}
