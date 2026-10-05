import { describe, expect, it } from "vitest";
import {
  PROFILE_FIELDS,
  parseProfileForm,
  profileEntries,
} from "@/lib/business-profile";

/**
 * What counts as a business's general information, and what is accepted.
 *
 * These values are published on a client's live website by an agent that is
 * told to use them exactly as written, so the checks that matter are the ones
 * that stop a typo becoming the site's phone number or booking link.
 */

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

describe("parseProfileForm", () => {
  it("keeps what was filled in, trimmed, and drops what was left empty", () => {
    const result = parseProfileForm(
      form({ businessName: "  Acme Plumbing ", phone: "(208) 555-0100", tagline: "   " }),
    );

    expect(result).toEqual({
      ok: true,
      details: { businessName: "Acme Plumbing", phone: "(208) 555-0100" },
    });
  });

  it("keeps the line breaks in long answers and removes them from short ones", () => {
    const result = parseProfileForm(
      form({ hours: "Mon–Fri 8am–5pm\nSat 9am–1pm", businessName: "Acme\nPlumbing" }),
    );

    expect(result.ok && result.details.hours).toBe("Mon–Fri 8am–5pm\nSat 9am–1pm");
    expect(result.ok && result.details.businessName).toBe("Acme Plumbing");
  });

  it("refuses a link that is not a web address, naming the field", () => {
    const result = parseProfileForm(form({ bookingUrl: "javascript:alert(1)", instagram: "instagram" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual(["bookingUrl", "instagram"]);
    }
  });

  it("refuses an email or phone number that cannot be one", () => {
    const result = parseProfileForm(form({ email: "acme at example", phone: "call us" }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors).sort()).toEqual(["email", "phone"]);
  });

  it("refuses an answer too long to be what the field asks for", () => {
    const result = parseProfileForm(form({ tagline: "x".repeat(400) }));
    expect(result.ok).toBe(false);
  });

  it("ignores anything that is not one of the fields", () => {
    const result = parseProfileForm(form({ phone: "208-555-0100", isAdmin: "true" }));
    expect(result).toEqual({ ok: true, details: { phone: "208-555-0100" } });
  });
});

describe("profileEntries", () => {
  it("lists what is filled in, labelled, in the form's order", () => {
    const entries = profileEntries({ phone: "208-555-0100", businessName: "Acme", unknown: "x" });

    expect(entries).toEqual([
      { key: "businessName", label: "Business name", value: "Acme" },
      { key: "phone", label: "Phone", value: "208-555-0100" },
    ]);
  });

  it("is empty for a profile nobody has filled in", () => {
    expect(profileEntries({})).toEqual([]);
    expect(profileEntries(null)).toEqual([]);
  });
});

describe("PROFILE_FIELDS", () => {
  it("names every field once", () => {
    const keys = PROFILE_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
