import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom, NotFoundError } from "@/db/repositories/context";
import {
  archivePotentialClient,
  getPotentialClient,
  updatePotentialClient,
} from "@/db/repositories/admin/potential-clients";
import { convertProspect, readConversion } from "@/db/repositories/admin/conversion";
import {
  POTENTIAL_CLIENT_ERRORS,
  PotentialClientFields,
  potentialClientFromForm,
} from "../fields";
import { ConversionPanel } from "./conversion-panel";

export const dynamic = "force-dynamic";

/** Edit a potential client, or take them off the list. */
export default async function EditPotentialClientPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role !== "admin") redirect("/dashboard");

  const { publicId } = await params;
  const { error: errorKey } = await searchParams;
  const error = errorKey ? POTENTIAL_CLIENT_ERRORS[errorKey] : undefined;

  const db = await getDb();
  let prospect;
  try {
    prospect = await getPotentialClient(adminContextFrom(user), db, publicId);
  } catch (caught) {
    if (caught instanceof NotFoundError) notFound();
    throw caught;
  }

  async function save(formData: FormData) {
    "use server";
    const session = await currentUser();
    if (!session || session.role !== "admin") redirect("/login");

    const outcome = await updatePotentialClient(
      adminContextFrom(session),
      await getDb(),
      publicId,
      potentialClientFromForm(formData),
    );

    if (!outcome.ok) redirect(`/admin/clients/potential/${publicId}?error=${outcome.reason}`);
    redirect("/admin/clients#potential-clients");
  }

  async function remove() {
    "use server";
    const session = await currentUser();
    if (!session || session.role !== "admin") redirect("/login");

    await archivePotentialClient(adminContextFrom(session), await getDb(), publicId);
    redirect("/admin/clients#potential-clients");
  }

  // The operator API's conversion, with the operator as the actor. The report
  // is read back from the audit log on the redirect, not passed through it.
  async function convert(formData: FormData) {
    "use server";
    const session = await currentUser();
    if (!session || session.role !== "admin") redirect("/login");

    const outcome = await convertProspect(adminContextFrom(session), await getDb(), publicId, {
      invite: formData.get("invite") === "on",
      via: "admin",
    });
    // The redirect is to this same page, which the router would otherwise
    // only scroll to, leaving the button where the report should be.
    revalidatePath(`/admin/clients/potential/${publicId}`);
    revalidatePath("/admin/clients");
    redirect(
      `/admin/clients/potential/${publicId}${outcome.ok ? "" : "?error=conversion_in_progress"}#conversion`,
    );
  }

  const conversion = await readConversion(db, publicId);

  return (
    <>
      <main className="shell">
        <div className="masthead">
          <h1>{prospect.businessName}</h1>
        </div>

        <form className="card" action={save} style={{ maxWidth: "34rem" }}>
          {error && <p className="error">{error}</p>}

          <PotentialClientFields values={prospect} />

          <button type="submit">Save changes</button>
        </form>

        <ConversionPanel
          businessName={prospect.businessName}
          conversion={conversion}
          convert={convert}
        />

        <form className="card" action={remove} style={{ maxWidth: "34rem" }}>
          <div className="card-head">
            <h2>Remove from the list</h2>
          </div>
          <p className="field-hint" style={{ marginTop: 0 }}>
            Hides them from the Clients page. The record is kept, not deleted.
          </p>
          {/* The name is in the page heading; spelled out in an uppercase
              button, a long one wrapped to three lines. A screen reader still
              hears whom it removes. */}
          <button type="submit" className="secondary" aria-label={`Remove ${prospect.businessName}`}>
            Remove them
          </button>
        </form>
      </main>
    </>
  );
}
