"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_LINKS, SITE } from "@/lib/site";

/**
 * The only client component on the site, and only because `aria-current`
 * needs to know which route is active. Everything else renders on the server
 * and ships no JavaScript.
 */
export function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="masthead">
      <div className="wrap masthead__inner">
        <Link href="/" className="brand">
          Mortensen<span className="brand__mark">Web</span>
        </Link>

        <nav className="nav" aria-label="Main">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="nav__link"
              // `startsWith` rather than equality so a future nested route
              // like /work/some-project still lights up its section.
              aria-current={pathname.startsWith(link.href) ? "page" : undefined}
            >
              {link.label}
            </Link>
          ))}

          {/*
            Leaves the site, so it is a plain anchor rather than a Link — the
            client router cannot prefetch another origin and would only add a
            failed request.
          */}
          <a className="nav__link nav__portal" href={SITE.portalUrl}>
            Client login
          </a>
        </nav>
      </div>
    </header>
  );
}
