"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavItem } from "./shell-nav";
import { activeHref } from "./shell-routes";

export type { NavItem } from "./shell-nav";

/**
 * Navigation with the current tab marked.
 *
 * A client component only because `aria-current` needs the active path, which
 * a server component cannot read. The items themselves are decided on the
 * server and passed in, so which tabs a role can see is never a client-side
 * decision — the pages behind them gate independently regardless.
 */
export function NavLinks({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  // Decided once for the whole nav, because "most specific" is a property of
  // the set — see `activeHref` for why the section home only matches itself.
  const active = activeHref(
    pathname,
    items.map((item) => item.href),
  );

  return (
    <nav className="nav" aria-label="Sections">
      <div className="nav-inner">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            // Deliberately NOT `prefetch`. Every page here is
            // `force-dynamic`, so prefetching a tab means the server renders
            // that whole page — its database queries and, for the
            // dashboard, its analytics calls — the moment the link scrolls
            // into view, whether or not it is ever tapped. With three tabs
            // that was three full page renders per page view. The default
            // (fetch on hover, and on touch-start on a phone) still gets
            // the payload moving before the tap lands, and every route now
            // has a `loading.tsx`, so a tab lights up and shows its skeleton
            // instantly rather than sitting dead.
            aria-current={item.href === active ? "page" : undefined}
          >
            {item.label}
            {item.count ? (
              <span className="nav-count">
                {item.count > 99 ? "99+" : item.count}
                <span className="sr-only"> unread</span>
              </span>
            ) : null}
          </Link>
        ))}
      </div>
    </nav>
  );
}
