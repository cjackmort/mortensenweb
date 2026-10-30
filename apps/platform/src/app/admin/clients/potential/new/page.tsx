import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import { createProspect } from "@/db/repositories/admin/prospects";
import {
  POTENTIAL_CLIENT_ERRORS,
  PotentialClientFields,
  potentialClientFromForm,
} from "../fields";

export const dynamic = "force-dynamic";

/**
 * Add a potential client.
 *
 * Writes a `prospects` row and nothing else: no organization, no client, no
 * account, no email. It shows up under the real clients on the Clients page,
 * and turning it into one is the separate "Add a client" step.
 */
export default async function NewPotentialClientPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role !== "admin") redirect("/dashboard");

  const params = await searchParams;
  const error = params.error ? POTENTIAL_CLIENT_ERRORS[params.error] : undefined;

  async function submit(formData: FormData) {
    "use server";
    const session = await currentUser();
    if (!session || session.role !== "admin") redirect("/login");

    const ctx = adminContextFrom(session);
    const db = await getDb();
    const created = await createProspect(ctx, db, potentialClientFromForm(formData));

    if (!created.ok) redirect(`/admin/clients/potential/new?error=${created.reason}`);
    redirect("/admin/clients#potential-clients");
  }

  return (
    <>
      <main className="shell">
        <div className="masthead">
          <h1>Add a potential client</h1>
        </div>

        <form className="card" action={submit} style={{ maxWidth: "34rem" }}>
          {error && <p className="error">{error}</p>}

          <PotentialClientFields />

          <button type="submit">Add potential client</button>

          <p className="field-hint" style={{ margin: "0.75rem 0 0" }}>
            They are listed below your clients and are kept apart from them: no
            account, no billing, no reports and no emails.
          </p>
        </form>
      </main>
    </>
  );
}
