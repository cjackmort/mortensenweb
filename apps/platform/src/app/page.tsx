import { redirect } from "next/navigation";
import { sessionHint } from "@/auth";

export const dynamic = "force-dynamic";

/**
 * The router. It renders nothing and reads nothing.
 *
 * Every arrival here — the post-sign-in redirect, a bookmark of the bare
 * domain — is sent on to the page for their role, and *that* page is where
 * the session is validated against the database. Doing the validation here
 * too meant paying for it twice on every sign-in, with nothing to show for
 * the first one but a redirect.
 */
export default async function Home() {
  const hint = await sessionHint();
  if (!hint) redirect("/login");
  // An emailed temporary credential gets no further than this.
  if (hint.mustChangePassword) redirect("/change-password");
  redirect(hint.role === "admin" ? "/admin" : "/dashboard");
}
