import Link from "next/link";
import { signOut } from "@/auth";
import { switchBackToAdmin, switchToMortensenWeb } from "@/app/client-view/actions";
import { closeClientView } from "@/lib/auth/client-view-cookie";
import type { AuthenticatedUser } from "@/lib/auth/session";
import { NO_CLIENT_SECTIONS, type ClientSections } from "@/db/repositories/client/sections";
import { NavLinks, type NavItem } from "./nav-links";
import { UserAvatar } from "./user-avatar";
import { PrivacyFooter } from "./privacy-link";

/**
 * The chrome around every signed-in page: brand, identity, navigation, sign-out.
 *
 * Navigation is chosen from the session's role here on the server. That is a
 * convenience, not a control — each page still gates itself, and the repository
 * layer still scopes every query. Hiding a link the user cannot use is good UI;
 * it is never the reason they cannot reach the data.
 */

/*
 * Only routes that exist. A tab leading to a 404 is worse than a missing tab,
 * so these grow as the sections are built rather than being stubbed ahead.
 */
const ADMIN_NAV: NavItem[] = [
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
function clientNav(sections: ClientSections, unreadLeads: number): NavItem[] {
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

export function AppShell({
  user,
  unreadLeads = 0,
  clientSections = NO_CLIENT_SECTIONS,
  children,
}: {
  user: AuthenticatedUser;
  /** Shown on the Growth tab. Counted by the client layout; admins have no inbox. */
  unreadLeads?: number;
  /** Which optional tabs this client has. Read by the client layout. */
  clientSections?: ClientSections;
  children: React.ReactNode;
}) {
  const isAdmin = user.role === "admin";

  async function endSession() {
    "use server";
    await closeClientView();
    await signOut({ redirectTo: "/login" });
  }

  return (
    <div className="app">
      {/* The tabs live inside the sticky header, so they never scroll away
          from the page they navigate. */}
      <header className="topbar">
        {/* While the operator is using the portal as the agency's own client,
            so it is never mistaken for the admin view. */}
        {user.viewingAs && (
          <div className="client-view-bar">
            <div className="client-view-bar-inner">
              <p>
                Viewing <strong>{user.viewingAs.organizationName}</strong> as a client.
                What you submit here is real.
              </p>
              <form action={switchBackToAdmin}>
                <button type="submit" className="small">
                  Back to admin
                </button>
              </form>
            </div>
          </div>
        )}
        <div className="topbar-inner">
          {/* mortensenweb.com's lockup: the M. mark, the wordmark with "Web"
              in the blue, and "Co." in mono. */}
          <Link
            className="brand"
            href={isAdmin ? "/admin" : "/dashboard"}
            aria-label={`Mortensen Web Co. ${isAdmin ? "Admin" : "Portal"}`}
          >
            <span className="brand-mark" aria-hidden="true">
              M<i />
            </span>
            <span className="brand-word" aria-hidden="true">
              Mortensen<em>Web</em>
            </span>
            <span className="brand-co" aria-hidden="true">
              Co.
            </span>
            <span className="brand-role" aria-hidden="true">
              {isAdmin ? "Admin" : "Portal"}
            </span>
          </Link>

          <div className="topbar-meta">
            {isAdmin && (
              <form action={switchToMortensenWeb}>
                <button type="submit" className="secondary small" aria-label="Switch to MortensenWeb">
                  <span className="switch-verb">Switch to </span>MortensenWeb
                </button>
              </form>
            )}
            {isAdmin ? (
              <span className="who" title={user.email}>
                {user.name ?? user.email}
              </span>
            ) : (
              // Their picture and name open their profile. The picture stays
              // on a phone when the name is hidden, so the page is one tap
              // away at every width.
              <Link className="who who-link" href="/dashboard/profile" title="Your profile">
                <UserAvatar user={user} />
                <span className="who-name">{user.name ?? user.email}</span>
              </Link>
            )}
            <form action={endSession}>
              <button type="submit" className="secondary small">
                Sign out
              </button>
            </form>
          </div>
        </div>

        <NavLinks items={isAdmin ? ADMIN_NAV : clientNav(clientSections, unreadLeads)} />
      </header>

      {children}

      <PrivacyFooter />
    </div>
  );
}
