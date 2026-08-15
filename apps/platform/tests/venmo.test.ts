import { describe, expect, it } from "vitest";
import {
  buildNote,
  buildVenmoPaymentUrl,
  formatAmount,
  generatePaymentReference,
  isValidVenmoHandle,
  normaliseVenmoHandle,
} from "@/lib/payments/venmo";

describe("payment reference", () => {
  it("is quotable and avoids visually ambiguous characters", () => {
    for (let i = 0; i < 200; i += 1) {
      const reference = generatePaymentReference();
      expect(reference).toMatch(/^MW-[0-9A-HJKMNP-TV-Z]{4}$/);
      // I, L, O and U are excluded so a reference read aloud is unambiguous.
      expect(reference).not.toMatch(/[ILOU]/);
    }
  });

  it("does not repeat within a small sample", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(generatePaymentReference());
    // 32^4 = ~1M combinations; 500 draws should essentially never collide.
    expect(seen.size).toBeGreaterThan(495);
  });
});

describe("amount formatting", () => {
  it("formats whole and fractional dollars without floating point error", () => {
    expect(formatAmount(15000)).toBe("150.00");
    expect(formatAmount(9999)).toBe("99.99");
    expect(formatAmount(5)).toBe("0.05");
    expect(formatAmount(100)).toBe("1.00");
  });

  it("handles amounts where naive float maths would drift", () => {
    // 0.1 + 0.2 style failures cannot occur because we never leave integers.
    expect(formatAmount(1010)).toBe("10.10");
    expect(formatAmount(70)).toBe("0.70");
  });
});

describe("handle validation", () => {
  it("strips a leading @", () => {
    expect(normaliseVenmoHandle("@Jack-Mortensen")).toBe("Jack-Mortensen");
    expect(normaliseVenmoHandle("  @@Jack  ")).toBe("Jack");
  });

  it("rejects handles that are not plausible usernames", () => {
    expect(isValidVenmoHandle("Jack-Mortensen")).toBe(true);
    expect(isValidVenmoHandle("abc")).toBe(false);
    expect(isValidVenmoHandle("has spaces")).toBe(false);
    expect(isValidVenmoHandle("bad/slash")).toBe(false);
  });
});

describe("venmo payment url", () => {
  const base = {
    handle: "@Jack-Mortensen",
    amountCents: 15000,
    reference: "MW-7F3K",
    businessName: "Northwind Comfort",
  };

  it("builds a link with the amount, recipient and reference", () => {
    const url = new URL(buildVenmoPaymentUrl(base));
    expect(url.origin + url.pathname).toBe("https://venmo.com/");
    expect(url.searchParams.get("txn")).toBe("pay");
    expect(url.searchParams.get("recipients")).toBe("Jack-Mortensen");
    expect(url.searchParams.get("amount")).toBe("150.00");
    expect(url.searchParams.get("note")).toContain("MW-7F3K");
  });

  it("keeps the transaction private", () => {
    // Venmo's feed is public by default. Broadcasting a payment annotated with
    // a client's business name would disclose the customer list.
    const url = new URL(buildVenmoPaymentUrl(base));
    expect(url.searchParams.get("audience")).toBe("private");
  });

  it("refuses a zero or negative amount", () => {
    expect(() => buildVenmoPaymentUrl({ ...base, amountCents: 0 })).toThrow();
    expect(() => buildVenmoPaymentUrl({ ...base, amountCents: -500 })).toThrow();
  });

  it("refuses a non-integer amount", () => {
    expect(() => buildVenmoPaymentUrl({ ...base, amountCents: 10.5 })).toThrow();
  });

  it("refuses an invalid handle rather than producing a dead link", () => {
    expect(() => buildVenmoPaymentUrl({ ...base, handle: "no" })).toThrow();
  });

  it("escapes note contents into the query string", () => {
    const url = buildVenmoPaymentUrl({
      ...base,
      businessName: "Smith & Sons / HVAC",
    });
    // The raw ampersand must not introduce a new query parameter.
    expect(new URL(url).searchParams.get("amount")).toBe("150.00");
    expect(new URL(url).searchParams.get("note")).toContain("Smith & Sons");
  });
});

describe("note construction", () => {
  it("leads with the reference so truncation cannot remove it", () => {
    expect(buildNote("MW-7F3K", "Northwind")).toMatch(/^MW-7F3K/);
  });

  it("drops the business name rather than exceeding the length budget", () => {
    const long = "A".repeat(200);
    const note = buildNote("MW-7F3K", long);
    expect(note.length).toBeLessThanOrEqual(100);
    expect(note).toContain("MW-7F3K");
  });
});
