import Link from "next/link";
import { signOut } from "@/auth";
import { switchBackToAdmin, switchToMortensenWeb } from "@/app/client-view/actions";
import { closeClientView } from "@/lib/auth/client-view-cookie";
import type { AuthenticatedUser } from "@/lib/auth/session";
import { NO_CLIENT_SECTIONS, type ClientSections } from "@/db/repositories/client/sections";
import { ADMIN_NAV, clientNav } from "./shell-nav";
import { ShellFrame } from "./shell-frame";
import { UserAvatar } from "./user-avatar";
import { PrivacyFooter } from "./privacy-link";
import { NoiseBackdrop } from "./noise-backdrop";

/**
 * The chrome around every signed-in page: brand, identity, navigation, sign-out.
 *
 * Navigation is chosen from the session's role here on the server. That is a
 * convenience, not a control — each page still gates itself, and the repository
 * layer still scopes every query. Hiding a link the user cannot use is good UI;
 * it is never the reason they cannot reach the data.
 *
 * The pieces are rendered here and handed to `ShellFrame`, which decides from
 * the path whether to show them: the brand row and tabs on a section root, a
 * back button anywhere deeper. The tab lists live in `shell-nav.ts`.
 */
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

  // While the operator is using the portal as the agency's own client, so it
  // is never mistaken for the admin view. On every screen, sub-pages included:
  // it is the one thing that says what they submit here is real.
  const notice = user.viewingAs ? (
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
  ) : null;

  const topbar = (
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
  );

  return (
    <div className="app">
      <NoiseBackdrop />
      <ShellFrame
        items={isAdmin ? ADMIN_NAV : clientNav(clientSections, unreadLeads)}
        notice={notice}
        topbar={topbar}
      >
        {children}
      </ShellFrame>

      <PrivacyFooter />
    </div>
  );
}
