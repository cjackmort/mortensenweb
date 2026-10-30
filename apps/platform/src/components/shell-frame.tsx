"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { NavLinks } from "./nav-links";
import type { NavItem } from "./shell-nav";
import { isSectionRoot, nextCameFrom, returnTargetFor, transitionFor } from "./shell-routes";
import { SubpageBar } from "./subpage-bar";

/** Long enough to read as a new screen arriving, short enough never to be waited on. */
const ENTER_MS = 180;
/** How far the page travels as it arrives. A hint of direction, not a slide show. */
const ENTER_OFFSET = "1rem";
/** `--ease-out` in globals.css. WAAPI cannot read a custom property. */
const ENTER_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * The part of the shell that depends on where the person is.
 *
 * On a section root — one of their tabs — the header holds the top bar and the
 * tabs, as it always has. Anywhere deeper it holds only a back button, so a
 * page like a lead or the profile reads as a screen opened on top of the list
 * it came from rather than one more stop under the same tabs.
 *
 * Decided here from `usePathname()` rather than by each page, so a route's
 * `loading.tsx` skeleton shows in the right mode the instant a link is tapped.
 * The server-rendered parts — brand, avatar, the sign-out form and its server
 * action, the client-view notice — arrive as props and are only placed here.
 */
export function ShellFrame({
  items,
  notice,
  topbar,
  children,
}: {
  /** The tabs this person has. A path equal to one of them is a section root. */
  items: NavItem[];
  /** Shown on every screen, sub-pages included: the client-view safety notice. */
  notice?: React.ReactNode;
  /** The brand row, shown only on section roots. */
  topbar: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  // Where a side trip to a page under no tab (profile, connections) started,
  // so its back button can return there. Updated during render rather than in
  // an effect, so the button is right on the first paint of the new page.
  const [trail, setTrail] = useState<{ path: string; cameFrom: string | null }>({
    path: pathname,
    cameFrom: null,
  });
  const cameFrom =
    trail.path === pathname
      ? trail.cameFrom
      : nextCameFrom(trail.path, pathname, trail.cameFrom, items);
  if (trail.path !== pathname) setTrail({ path: pathname, cameFrom });

  const isRoot = isSectionRoot(pathname, items);

  const pageRef = useRef<HTMLDivElement>(null);
  const shownPath = useRef(pathname);
  // A layout effect, so the first frame of the new page is already the
  // animation's first frame rather than a flash of it in place.
  useLayoutEffect(() => {
    const from = shownPath.current;
    shownPath.current = pathname;

    const direction = transitionFor(from, pathname, items);
    const page = pageRef.current;
    if (direction === "none" || !page || typeof page.animate !== "function") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const offset = direction === "forward" ? ENTER_OFFSET : `-${ENTER_OFFSET}`;
    const animation = page.animate(
      [
        { opacity: 0, transform: `translateX(${offset})` },
        { opacity: 1, transform: "none" },
      ],
      { duration: ENTER_MS, easing: ENTER_EASING },
    );
    return () => animation.cancel();
  }, [pathname, items]);

  return (
    <>
      <header className={isRoot ? "topbar" : "topbar is-subpage"}>
        {notice}
        {isRoot ? (
          <>
            {topbar}
            {/* The tabs live inside the sticky header, so they never scroll
                away from the page they navigate. */}
            <NavLinks items={items} />
          </>
        ) : (
          <SubpageBar target={returnTargetFor(pathname, items, cameFrom)} />
        )}
      </header>

      <div className="app-page" ref={pageRef}>
        {children}
      </div>
    </>
  );
}
