"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  href: string;
  label: string;
}

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

  // The longest href that this path sits under. Computed once for the whole
  // nav rather than per item, because "most specific" is a property of the set.
  const bestMatch = items
    .map((item) => item.href)
    .filter(
      (href) =>
        pathname === href || (href !== "/" && pathname.startsWith(`${href}/`)),
    )
    .sort((a, b) => b.length - a.length)[0];

  return (
    <nav className="nav" aria-label="Sections">
      <div className="nav-inner">
        {items.map((item) => {
          // Only the *most specific* match is active.
          //
          // Prefix-matching each item independently made the section root
          // permanently active: Overview is `/admin`, and every other admin
          // page starts with `/admin/`, so Overview stayed lit on Requests, on
          // Payments, on everything. The client nav had the same fault with
          // `/dashboard`.
          //
          // Comparing against the longest matching href instead means a nested
          // page still highlights its parent — `/admin/clients/abc` lights
          // Clients — while a sibling never lights its ancestor too.
          const active = item.href === bestMatch;

          return (
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
              aria-current={active ? "page" : undefined}
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
