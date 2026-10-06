import Link from "next/link";
import { signOut } from "@/auth";
import type { AuthenticatedUser } from "@/lib/auth/session";
import { NavLinks, type NavItem } from "./nav-links";

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
  { href: "/admin/payments", label: "Payments" },
  { href: "/admin/mortensenweb", label: "MortensenWeb" },
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
  { href: "/dashboard/requests", label: "Requests" },
  // Between Requests and Billing rather than at the end, because the library is
  // part of asking for a change — a client uploads photos and then refers to
  // them — while Billing is a place you go for its own reasons.
  { href: "/dashboard/media", label: "Media" },
  { href: "/dashboard/billing", label: "Billing" },
];

export function AppShell({
  user,
  children,
}: {
  user: AuthenticatedUser;
  children: React.ReactNode;
}) {
  const isAdmin = user.role === "admin";

  async function endSession() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  return (
    <div className="app">
      {/* The tabs live inside the sticky header, so they never scroll away
          from the page they navigate. */}
      <header className="topbar">
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
            <span className="who" title={user.email}>
              {user.name ?? user.email}
            </span>
            <form action={endSession}>
              <button type="submit" className="secondary small">
                Sign out
              </button>
            </form>
          </div>
        </div>

        <NavLinks items={isAdmin ? ADMIN_NAV : CLIENT_NAV} />
      </header>

      {children}
    </div>
  );
}
