import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import { createClient } from "@/db/repositories/admin/clients";

export const dynamic = "force-dynamic";

/**
 * Add a client.
 *
 * This creates the record only. It issues no credential and sends no email —
 * activation is a separate, deliberate step on the client's own page, because
 * it grants real access and the plan requires that not to be a side effect of
 * filling in a name.
 */
export default async function NewClientPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role !== "admin") redirect("/dashboard");

  const params = await searchParams;

  async function submit(formData: FormData) {
    "use server";
    const session = await currentUser();
    if (!session || session.role !== "admin") redirect("/login");

    const ctx = adminContextFrom(session);
    const db = await getDb();

    const businessName = String(formData.get("businessName") ?? "").trim();
    if (businessName.length < 2) {
      redirect("/admin/clients/new?error=name");
    }

    const created = await createClient(ctx, db, {
      businessName,
      primaryContactName: String(formData.get("primaryContactName") ?? ""),
      primaryContactEmail: String(formData.get("primaryContactEmail") ?? ""),
      phone: String(formData.get("phone") ?? ""),
      industry: String(formData.get("industry") ?? ""),
    });

    // Straight to their page, which is where activation lives.
    redirect(`/admin/clients/${created.clientPublicId}`);
  }

  return (
    <>
      <main className="shell">
        <div className="masthead">
          <h1>Add a client</h1>
          <span className="muted">
            <Link href="/admin/clients">← All clients</Link>
          </span>
        </div>

        <form className="card" action={submit} style={{ maxWidth: "34rem" }}>
          {params.error === "name" && (
            <p className="error">Please enter the business name.</p>
          )}

          <label htmlFor="businessName">Business name</label>
          <input
            id="businessName"
            name="businessName"
            type="text"
            placeholder="Scott Mortensen Fine Arts"
            required
            minLength={2}
            maxLength={120}
          />
          <p className="field-hint">
            Used for their sign-in handle and everywhere they see themselves
            named. Their handle is generated at activation.
          </p>

          <label htmlFor="primaryContactName">Contact name</label>
          <input
            id="primaryContactName"
            name="primaryContactName"
            type="text"
            placeholder="Scott Mortensen"
          />

          <label htmlFor="primaryContactEmail">Contact email</label>
          <input
            id="primaryContactEmail"
            name="primaryContactEmail"
            type="email"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="name@example.com"
          />
          <p className="field-hint">
            Where the welcome email goes at activation. It can be changed before
            you activate them.
          </p>

          <label htmlFor="phone">Phone</label>
          <input id="phone" name="phone" type="tel" placeholder="555-0100" />

          <label htmlFor="industry">Industry</label>
          <input
            id="industry"
            name="industry"
            type="text"
            placeholder="fine art / sculpture"
          />

          <button type="submit">Create client</button>

          <p className="field-hint" style={{ margin: "0.75rem 0 0" }}>
            This creates the record only. No account is made and no email is
            sent until you activate them on the next screen.
          </p>
        </form>
      </main>
    </>
  );
}
