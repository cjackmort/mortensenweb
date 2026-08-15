import { redirect } from "next/navigation";
import { currentUser } from "@/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await currentUser();
  if (!user) redirect("/login");
  redirect(user.role === "admin" ? "/admin" : "/dashboard");
}
