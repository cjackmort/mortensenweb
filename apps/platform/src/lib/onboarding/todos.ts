import { formatMoney } from "./checkout";

/**
 * "Get started": what a new client has left to do before their portal is
 * running properly, worked out from facts the loader reads out of the
 * database (`db/repositories/client/onboarding.ts`).
 *
 * Pure, so every state a client can be in is a unit test rather than a
 * seeded database. Each to-do is done or not from those facts alone — never
 * from the client ticking it off — because a box that says "done" while the
 * phone number is still missing is worse than no box.
 *
 * ## Required and optional
 *
 * Required to-dos are the ones without which something the client is paying
 * for does not work: the site is unpaid, the site and portal have no phone
 * number to show, a booking site has no times to book, a shop cannot take
 * money. The "Get started" tab and the home-page banner stay while any of
 * these is left (see `sections.ts`). The rest — a plan, photos, listings,
 * Search Console — are worth doing and listed, but never hold the tab open.
 *
 * `requiredTodos` takes only the facts behind required to-dos, because the
 * dashboard layout reads them on every page and should not pay for the rest.
 */

export type TodoKey =
  | "password"
  | "pay"
  | "details"
  | "availability"
  | "shop"
  | "address"
  | "plan"
  | "media"
  | "listings"
  | "search";

/** The business details the site and portal cannot do without. */
export const BUSINESS_DETAIL_KEYS = ["phone", "email", "hours", "services"] as const;
export type BusinessDetailKey = (typeof BUSINESS_DETAIL_KEYS)[number];

const DETAIL_LABELS: Record<BusinessDetailKey, string> = {
  phone: "phone number",
  email: "public email",
  hours: "opening hours",
  services: "services",
};

export interface RequiredFacts {
  passwordChosen: boolean;
  sitePayment: {
    /** `not_needed`: on the house, or the agency's own site. `confirming`: they told us they paid. */
    state: "paid" | "not_needed" | "due" | "confirming";
    amountCents: number | null;
  };
  /** Of `BUSINESS_DETAIL_KEYS`, the ones still empty. */
  businessDetailsMissing: BusinessDetailKey[];
  hasAddress: boolean;
  /** Win-back email cannot go out without a postal address (CAN-SPAM). */
  addressRequired: boolean;
  booking: { enabled: boolean; availabilityReady: boolean };
  shop: { enabled: boolean; paymentsReady: boolean; productCount: number };
}

export interface OptionalFacts {
  plan: { state: "chosen" | "none" | "complimentary"; name: string | null };
  /** Files in the media library that finished processing. */
  mediaReady: number;
  /** Null when the client has no site yet, so nothing to list. */
  listings: { done: number; total: number } | null;
  searchConsole: "connected" | "needs_reconnect" | "not_connected";
}

export type OnboardingFacts = RequiredFacts & OptionalFacts;

export interface OnboardingTodo {
  key: TodoKey;
  title: string;
  /** One line: what is left, or why it matters. */
  detail: string;
  href: string;
  /** The link's words. */
  action: string;
  done: boolean;
  required: boolean;
}

export interface OnboardingProgress {
  done: number;
  total: number;
  requiredLeft: number;
  /** "3 of 8 done" */
  label: string;
}

/** "a, b and c" */
function listOf(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function passwordTodo(facts: RequiredFacts): OnboardingTodo {
  return {
    key: "password",
    title: "Choose your password",
    detail: facts.passwordChosen ? "Done. Only you know it." : "Replace the temporary password from your welcome email.",
    href: "/change-password",
    action: facts.passwordChosen ? "Change it" : "Choose",
    done: facts.passwordChosen,
    required: true,
  };
}

function payTodo(facts: RequiredFacts): OnboardingTodo {
  const { state, amountCents } = facts.sitePayment;
  const base = { key: "pay" as const, title: "Pay for your website", required: true };
  switch (state) {
    case "paid":
      return { ...base, detail: "Paid. Thank you.", href: "/dashboard/billing", action: "Receipts", done: true };
    case "not_needed":
      return { ...base, detail: "Nothing to pay for your site.", href: "/dashboard/billing", action: "Billing", done: true };
    case "confirming":
      return {
        ...base,
        detail: "You told us it's paid. We'll confirm it shortly.",
        href: "/dashboard/billing",
        action: "Billing",
        done: false,
      };
    case "due":
      return {
        ...base,
        detail:
          amountCents !== null
            ? `${formatMoney(amountCents)} for your site, paid once. You can add a plan at the same time.`
            : "One payment for your site. You can add a plan at the same time.",
        href: "/dashboard/welcome",
        action: "Pay now",
        done: false,
      };
  }
}

function detailsTodo(facts: RequiredFacts): OnboardingTodo {
  const missing = facts.businessDetailsMissing;
  const done = missing.length === 0;
  return {
    key: "details",
    title: "Fill in your business details",
    detail: done
      ? "Phone, email, hours and services are in. Every change we make uses them."
      : `Still missing: ${listOf(missing.map((k) => DETAIL_LABELS[k]))}.`,
    href: done ? "/dashboard/profile#profile-business" : `/dashboard/profile?field=${missing[0]}`,
    action: done ? "Review" : "Fill in",
    done,
    required: true,
  };
}

function availabilityTodo(facts: RequiredFacts): OnboardingTodo {
  const done = facts.booking.availabilityReady;
  return {
    key: "availability",
    title: "Set your availability",
    detail: done ? "Customers can book the times you opened." : "Customers can only book times you have opened.",
    href: "/dashboard/availability",
    action: done ? "Change" : "Set times",
    done,
    required: true,
  };
}

function shopTodo(facts: RequiredFacts): OnboardingTodo {
  const { paymentsReady, productCount } = facts.shop;
  const done = paymentsReady && productCount > 0;
  const detail = done
    ? `Stripe is connected and ${productCount} ${productCount === 1 ? "product is" : "products are"} added.`
    : !paymentsReady
      ? "Connect Stripe so sales are paid to you, then add your first product."
      : "Stripe is connected. Add your first product.";
  return {
    key: "shop",
    title: "Set up your shop",
    detail,
    href: "/dashboard/growth/shop",
    action: done ? "Open shop" : "Set up",
    done,
    required: true,
  };
}

function addressTodo(facts: RequiredFacts): OnboardingTodo {
  const done = facts.hasAddress;
  return {
    key: "address",
    title: "Add your business address",
    detail: done
      ? "Added."
      : facts.addressRequired
        ? "Win-back emails can't go out without one: US law requires a postal address in marketing email."
        : "Where customers find you. It also goes at the foot of review-request emails.",
    href: "/dashboard/profile?field=address",
    action: done ? "Change" : "Add",
    done,
    required: facts.addressRequired,
  };
}

function planTodo(facts: OptionalFacts): OnboardingTodo {
  const { state, name } = facts.plan;
  const base = { key: "plan" as const, title: "Choose a care plan and add-ons", required: false };
  if (state === "complimentary") {
    return { ...base, detail: "Your plan is on the house.", href: "/dashboard/plan", action: "Your plan", done: true };
  }
  if (state === "chosen") {
    return { ...base, detail: `You are on ${name ?? "a plan"}.`, href: "/dashboard/plan", action: "Your plan", done: true };
  }
  return {
    ...base,
    detail: "Optional. A plan covers changes to your site; add-ons bring in customers.",
    href: "/dashboard/welcome",
    action: "See plans",
    done: false,
  };
}

function mediaTodo(facts: OptionalFacts): OnboardingTodo {
  const done = facts.mediaReady > 0;
  return {
    key: "media",
    title: "Upload your logo and photos",
    detail: done
      ? `${facts.mediaReady} ${facts.mediaReady === 1 ? "file" : "files"} in your library, ready to use in a request.`
      : "Your logo and a few photos of your work, so changes to your site can use them.",
    href: "/dashboard/media",
    action: done ? "Library" : "Upload",
    done,
    required: false,
  };
}

function listingsTodo(listings: NonNullable<OptionalFacts["listings"]>): OnboardingTodo {
  const done = listings.done >= listings.total;
  return {
    key: "listings",
    title: "Get listed",
    detail: done
      ? "Listed everywhere on the checklist."
      : `${listings.done} of ${listings.total} listings done. Each one is a place people look for you.`,
    href: "/dashboard/listings",
    action: done ? "Checklist" : "Carry on",
    done,
    required: false,
  };
}

function searchTodo(facts: OptionalFacts): OnboardingTodo {
  const state = facts.searchConsole;
  return {
    key: "search",
    title: "Connect Google Search Console",
    detail:
      state === "connected"
        ? "Connected. Your search rankings come straight from Google."
        : state === "needs_reconnect"
          ? "The connection lapsed. Reconnect it to keep your search rankings coming."
          : "See what people search to find you, and where you rank, straight from Google.",
    href: "/dashboard/connections",
    action: state === "connected" ? "Connections" : state === "needs_reconnect" ? "Reconnect" : "Connect",
    done: state === "connected",
    required: false,
  };
}

/** The required to-dos, in order. */
export function requiredTodos(facts: RequiredFacts): OnboardingTodo[] {
  return [
    passwordTodo(facts),
    payTodo(facts),
    detailsTodo(facts),
    ...(facts.booking.enabled ? [availabilityTodo(facts)] : []),
    ...(facts.shop.enabled ? [shopTodo(facts)] : []),
    ...(facts.addressRequired ? [addressTodo(facts)] : []),
  ];
}

/** Every to-do, required first, each list in the order it is best done. */
export function onboardingTodos(facts: OnboardingFacts): OnboardingTodo[] {
  return [
    ...requiredTodos(facts),
    ...(facts.addressRequired ? [] : [addressTodo(facts)]),
    planTodo(facts),
    mediaTodo(facts),
    ...(facts.listings ? [listingsTodo(facts.listings)] : []),
    searchTodo(facts),
  ];
}

export function onboardingProgress(todos: readonly OnboardingTodo[]): OnboardingProgress {
  const done = todos.filter((t) => t.done).length;
  return {
    done,
    total: todos.length,
    requiredLeft: todos.filter((t) => t.required && !t.done).length,
    label: `${done} of ${todos.length} done`,
  };
}
