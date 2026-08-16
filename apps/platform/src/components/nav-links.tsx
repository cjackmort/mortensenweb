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

  return (
    <nav className="nav" aria-label="Sections">
      <div className="nav-inner">
        {items.map((item) => {
          // Exact match for the section root, prefix match beneath it, so a
          // detail page keeps its parent tab highlighted.
          const active =
            pathname === item.href ||
            (item.href !== "/" && pathname.startsWith(`${item.href}/`));

          return (
            <Link
              key={item.href}
              href={item.href}
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
