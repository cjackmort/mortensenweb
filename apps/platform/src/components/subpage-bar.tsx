import Link from "next/link";
import type { ShellLink } from "./shell-routes";

/**
 * The slim bar a sub-page shows in place of the top bar and tabs: one way
 * back, named after where it goes ("Growth", "Leads"), in the same place on
 * every screen. It sits in the sticky header, so it never scrolls away.
 */
export function SubpageBar({ target }: { target: ShellLink | null }) {
  return (
    <nav className="subpage-bar" aria-label="Back">
      <div className="subpage-bar-inner">
        {target && (
          <Link className="subpage-back" href={target.href}>
            <svg
              className="subpage-back-arrow"
              viewBox="0 0 20 20"
              width="18"
              height="18"
              aria-hidden="true"
              focusable="false"
            >
              <path
                d="M12.5 4.5 7 10l5.5 5.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="square"
              />
            </svg>
            <span className="sr-only">Back to </span>
            <span className="subpage-back-label">{target.label}</span>
          </Link>
        )}
      </div>
    </nav>
  );
}
