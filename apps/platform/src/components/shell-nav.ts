import type { ClientSections } from "@/db/repositories/client/sections";

/**
 * The tabs, for both sides of the portal.
 *
 * Kept apart from `app-shell.tsx` so the rules that read them — which paths
 * are section roots, where a back button goes — can be tested against the
 * real list rather than a copy of it. Which list a person gets is still
 * decided on the server, from their role.
 */

export interface NavItem {
  href: string;
  label: string;
  /** A count shown beside the label — unread leads on Growth. Zero shows nothing. */
  count?: number;
}

/*
 * Only routes that exist. A tab leading to a 404 is worse than a missing tab,
 * so these grow as the sections are built rather than being stubbed ahead.
 */
export const ADMIN_NAV: NavItem[] = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/clients", label: "Clients" },
  { href: "/admin/requests", label: "Requests" },
  { href: "/admin/showcases", label: "Showcases" },
  { href: "/admin/payments", label: "Payments" },
  { href: "/admin/ads", label: "Ads" },
  { href: "/admin/google", label: "Google" },
  { href: "/admin/winback", label: "Win-back" },
  // MortensenWeb is hidden, not removed. "Switch to MortensenWeb" in the top
  // bar shows the agency's site exactly as a client sees it, which this tab
  // only approximated, and the agency's requests now sit in Requests, marked
  // "Your site", with the same dispatch button as every other request.
  // { href: "/admin/mortensenweb", label: "MortensenWeb" },
  // Prospects is hidden, not removed. Finding and pitching businesses moved out
  // of the portal to the `/pitch` command in the agency repo, which researches
  // keywords, rebuilds the site and previews it locally — so this tab duplicates
  // a workflow that now lives somewhere better.
  //
  // The route, the crawler and the tables all still work; only the link is
  // gone. Reversible in one line, which is the point: if the pitch workflow
  // does not hold up, nothing has to be rebuilt to come back here.
  // { href: "/admin/prospects", label: "Prospects" },
];

const CLIENT_NAV: NavItem[] = [
  // Visitor figures live on "Your site" rather than a tab of their own: a
  // separate Visitors page repeated the same headline numbers, which is two
  // places to look for one answer.
  { href: "/dashboard", label: "Your site" },
  // Second, because it is the one tab with something new in it on any given
  // day: a customer wrote in. See `docs/growth-plan.md`.
  { href: "/dashboard/growth", label: "Growth" },
  // The directories a live site still has to be told about. Third because a
  // new client's first weeks are mostly this, and it goes quiet once done.
  { href: "/dashboard/listings", label: "Get listed" },
  { href: "/dashboard/requests", label: "Requests" },
  // Between Requests and Billing rather than at the end, because the library is
  // part of asking for a change — a client uploads photos and then refers to
  // them — while Billing is a place you go for its own reasons.
  { href: "/dashboard/media", label: "Media" },
  // Looking back over a month, after the tabs for doing things this month.
  { href: "/dashboard/reports", label: "Reports" },
  // What they get and changing it, beside what they have paid. Separate tabs
  // because "cancel my plan" and "where is my receipt" are different errands.
  { href: "/dashboard/plan", label: "Plan" },
  { href: "/dashboard/billing", label: "Billing" },
];

/**
 * The client's tabs, with the optional sections in place: "Get started"
 * first while setup is unfinished, then the sections the operator opened for
 * this kind of site right after Growth.
 */
export function clientNav(sections: ClientSections, unreadLeads: number): NavItem[] {
  const optional: NavItem[] = [
    ...(sections.availability ? [{ href: "/dashboard/availability", label: "Availability" }] : []),
    ...(sections.shop ? [{ href: "/dashboard/growth/shop", label: "Shop" }] : []),
  ];
  const items = CLIENT_NAV.flatMap((item) =>
    item.href === "/dashboard/growth"
      ? [{ ...item, count: unreadLeads }, ...optional]
      : [item],
  );
  return sections.getStarted
    ? [{ href: "/dashboard/get-started", label: "Get started" }, ...items]
    : items;
}
