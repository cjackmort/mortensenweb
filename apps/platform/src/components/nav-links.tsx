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
              // Every page here is `force-dynamic`, so a click is a server
              // round trip and the tab sits dead until it returns. Prefetching
              // on hover and viewport entry means the payload is usually
              // already there by the time the click lands. There are four
              // tabs, all of them ones an operator uses constantly, so the
              // cost of fetching ahead is small and paid while idle.
              prefetch
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
