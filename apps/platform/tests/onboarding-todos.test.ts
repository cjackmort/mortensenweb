import { describe, expect, it } from "vitest";
import {
  onboardingProgress,
  onboardingTodos,
  requiredTodos,
  type OnboardingFacts,
} from "@/lib/onboarding/todos";

/**
 * "Get started": a new client's to-dos, from facts the loader reads out of
 * the database. Pure, so every state a client can be in is tested here
 * rather than by seeding a database for each.
 */

const NEW_CLIENT: OnboardingFacts = {
  passwordChosen: true,
  sitePayment: { state: "due", amountCents: 50_000 },
  businessDetailsMissing: ["phone", "email", "hours", "services"],
  hasAddress: false,
  addressRequired: false,
  booking: { enabled: false, availabilityReady: false },
  shop: { enabled: false, paymentsReady: false, productCount: 0 },
  plan: { state: "none", name: null },
  mediaReady: 0,
  listings: { done: 0, total: 8 },
  searchConsole: "not_connected",
};

const SET_UP: OnboardingFacts = {
  ...NEW_CLIENT,
  sitePayment: { state: "paid", amountCents: null },
  businessDetailsMissing: [],
  hasAddress: true,
  plan: { state: "chosen", name: "Care" },
  mediaReady: 4,
  listings: { done: 8, total: 8 },
  searchConsole: "connected",
};

const keys = (facts: OnboardingFacts) => onboardingTodos(facts).map((t) => t.key);
const todo = (facts: OnboardingFacts, key: string) => onboardingTodos(facts).find((t) => t.key === key)!;

describe("onboardingTodos", () => {
  it("lists the core to-dos for a new client, required ones first", () => {
    expect(keys(NEW_CLIENT)).toEqual([
      "password",
      "pay",
      "details",
      "address",
      "plan",
      "media",
      "listings",
      "search",
    ]);
    expect(onboardingTodos(NEW_CLIENT).filter((t) => t.required).map((t) => t.key)).toEqual([
      "password",
      "pay",
      "details",
    ]);
  });

  it("marks the password done, because nobody reaches the portal without choosing one", () => {
    expect(todo(NEW_CLIENT, "password")).toMatchObject({ done: true, required: true });
  });

  it("asks a new client to pay, quoting the amount and linking to the welcome checkout", () => {
    expect(todo(NEW_CLIENT, "pay")).toMatchObject({
      done: false,
      required: true,
      href: "/dashboard/welcome",
      detail: expect.stringContaining("$500"),
    });
  });

  it("counts a complimentary site as nothing to pay", () => {
    const facts = { ...NEW_CLIENT, sitePayment: { state: "not_needed" as const, amountCents: null } };
    expect(todo(facts, "pay")).toMatchObject({ done: true });
  });

  it("keeps the payment open, pointing at Billing, while a declared payment is confirmed", () => {
    const facts = { ...NEW_CLIENT, sitePayment: { state: "confirming" as const, amountCents: 50_000 } };
    expect(todo(facts, "pay")).toMatchObject({ done: false, href: "/dashboard/billing" });
  });

  it("names the business details still missing and links to the first of them", () => {
    const facts = { ...NEW_CLIENT, businessDetailsMissing: ["hours" as const, "services" as const] };
    const details = todo(facts, "details");

    expect(details.done).toBe(false);
    expect(details.detail).toBe("Still missing: opening hours and services.");
    expect(details.href).toBe("/dashboard/profile?field=hours");
  });

  it("makes the postal address required when win-back email needs it", () => {
    const facts = { ...NEW_CLIENT, addressRequired: true };
    const address = todo(facts, "address");

    expect(address.required).toBe(true);
    expect(address.detail).toMatch(/win-back/i);
    expect(onboardingTodos(facts).findIndex((t) => t.key === "address")).toBeLessThan(
      onboardingTodos(facts).findIndex((t) => t.key === "plan"),
    );
  });

  it("leaves the plan optional, and done once one is chosen or granted", () => {
    expect(todo(NEW_CLIENT, "plan")).toMatchObject({ required: false, done: false });
    expect(todo(SET_UP, "plan")).toMatchObject({ done: true, detail: "You are on Care." });
    expect(todo({ ...NEW_CLIENT, plan: { state: "complimentary", name: "Complimentary" } }, "plan")).toMatchObject({
      done: true,
    });
  });

  it("reports listing progress and is done only when every listing is", () => {
    const partway = { ...NEW_CLIENT, listings: { done: 3, total: 8 } };
    expect(todo(partway, "listings")).toMatchObject({ done: false, detail: expect.stringContaining("3 of 8") });
    expect(todo(SET_UP, "listings").done).toBe(true);
  });

  it("leaves listings out for a client with no site yet", () => {
    expect(keys({ ...NEW_CLIENT, listings: null })).not.toContain("listings");
  });

  it("asks for a reconnect when the Search Console connection has lapsed", () => {
    const lapsed = todo({ ...NEW_CLIENT, searchConsole: "needs_reconnect" }, "search");
    expect(lapsed.done).toBe(false);
    expect(lapsed.action).toBe("Reconnect");
  });

  it("adds availability for a booking site, as required", () => {
    const facts = { ...NEW_CLIENT, booking: { enabled: true, availabilityReady: false } };
    expect(todo(facts, "availability")).toMatchObject({
      required: true,
      done: false,
      href: "/dashboard/availability",
    });
    expect(todo({ ...facts, booking: { enabled: true, availabilityReady: true } }, "availability").done).toBe(true);
    expect(keys(NEW_CLIENT)).not.toContain("availability");
  });

  it("adds the shop for a store, done only with Stripe connected and a product added", () => {
    const store = { ...NEW_CLIENT, shop: { enabled: true, paymentsReady: false, productCount: 0 } };
    expect(todo(store, "shop")).toMatchObject({ required: true, done: false, detail: expect.stringMatching(/Stripe/) });

    const connected = { ...store, shop: { enabled: true, paymentsReady: true, productCount: 0 } };
    expect(todo(connected, "shop")).toMatchObject({ done: false, detail: expect.stringMatching(/first product/) });

    const ready = { ...store, shop: { enabled: true, paymentsReady: true, productCount: 2 } };
    expect(todo(ready, "shop").done).toBe(true);
    expect(keys(NEW_CLIENT)).not.toContain("shop");
  });
});

describe("requiredTodos", () => {
  it("needs only the facts the dashboard reads on every page", () => {
    const required = requiredTodos({
      passwordChosen: true,
      sitePayment: { state: "paid", amountCents: null },
      businessDetailsMissing: [],
      hasAddress: false,
      addressRequired: false,
      booking: { enabled: false, availabilityReady: false },
      shop: { enabled: false, paymentsReady: false, productCount: 0 },
    });
    expect(required.every((t) => t.required)).toBe(true);
    expect(required.every((t) => t.done)).toBe(true);
  });

  it("agrees with the full list about which to-dos are required", () => {
    const store = { ...NEW_CLIENT, addressRequired: true, shop: { enabled: true, paymentsReady: false, productCount: 0 } };
    expect(requiredTodos(store).map((t) => t.key)).toEqual(
      onboardingTodos(store).filter((t) => t.required).map((t) => t.key),
    );
  });
});

describe("onboardingProgress", () => {
  it("counts done to-dos and the required ones left", () => {
    const progress = onboardingProgress(onboardingTodos(NEW_CLIENT));
    expect(progress).toEqual({ done: 1, total: 8, requiredLeft: 2, label: "1 of 8 done" });
  });

  it("has nothing required left once a client is set up", () => {
    const progress = onboardingProgress(onboardingTodos(SET_UP));
    expect(progress.requiredLeft).toBe(0);
    expect(progress.done).toBe(progress.total);
  });
});
