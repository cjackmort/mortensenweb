import type { PotentialClient } from "@/db/repositories/admin/potential-clients";

/**
 * The fields of a potential client, shared by the add and edit pages so the
 * two can never drift apart. Everything but the name is optional: the usual
 * entry is somebody met in person, with whatever was written down at the time.
 */
export function PotentialClientFields({
  values,
}: {
  values?: Partial<PotentialClient>;
}) {
  return (
    <>
      <label htmlFor="businessName">Business name</label>
      <input
        id="businessName"
        name="businessName"
        type="text"
        required
        minLength={2}
        maxLength={120}
        defaultValue={values?.businessName ?? ""}
      />

      <label htmlFor="contactName">Contact name</label>
      <input
        id="contactName"
        name="contactName"
        type="text"
        defaultValue={values?.contactName ?? ""}
      />

      <label htmlFor="contactEmail">Contact email</label>
      <input
        id="contactEmail"
        name="contactEmail"
        type="email"
        autoCapitalize="none"
        spellCheck={false}
        placeholder="name@example.com"
        defaultValue={values?.contactEmail ?? ""}
      />

      <label htmlFor="contactPhone">Phone</label>
      <input
        id="contactPhone"
        name="contactPhone"
        type="tel"
        defaultValue={values?.contactPhone ?? ""}
      />

      <label htmlFor="sourceWebsiteUrl">Current website</label>
      <input
        id="sourceWebsiteUrl"
        name="sourceWebsiteUrl"
        type="text"
        inputMode="url"
        autoCapitalize="none"
        spellCheck={false}
        placeholder="example.com"
        defaultValue={values?.sourceWebsiteUrl ?? ""}
      />

      <label htmlFor="industry">Industry</label>
      <input
        id="industry"
        name="industry"
        type="text"
        defaultValue={values?.industry ?? ""}
      />

      <label htmlFor="location">Location</label>
      <input
        id="location"
        name="location"
        type="text"
        placeholder="Provo, UT"
        defaultValue={values?.location ?? ""}
      />

      <label htmlFor="notes">Notes</label>
      <textarea
        id="notes"
        name="notes"
        rows={4}
        placeholder="Where you met, what they need, when to follow up"
        defaultValue={values?.notes ?? ""}
      />
    </>
  );
}

/** Read the shared fields back out of a submitted form. */
export function potentialClientFromForm(formData: FormData) {
  const field = (name: string) => String(formData.get(name) ?? "");
  return {
    businessName: field("businessName"),
    contactName: field("contactName"),
    contactEmail: field("contactEmail"),
    contactPhone: field("contactPhone"),
    sourceWebsiteUrl: field("sourceWebsiteUrl"),
    industry: field("industry"),
    location: field("location"),
    notes: field("notes"),
  };
}

/** Messages for the `?error=` a failed submit redirects back with. */
export const POTENTIAL_CLIENT_ERRORS: Record<string, string> = {
  invalid_name: "Please enter the business name.",
  invalid_url: "That doesn't look like a website address.",
  conversion_in_progress: "A conversion is already running for them. Refresh in a minute for its report.",
};
