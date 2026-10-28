import Link from "next/link";

/**
 * The way back up, above a page's masthead.
 *
 * A Growth feature opens on its own page with nothing on it that says where
 * it came from: the Growth tab stays lit, but a tab is not a way back for
 * someone who tapped "Open leads" a moment ago and wants the list of tools
 * again. One line, same place on every feature page, so it is found without
 * looking.
 */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <p className="page-back">
      <Link href={href}>← {label}</Link>
    </p>
  );
}

/** The one every Growth feature page shows. */
export function BackToGrowth() {
  return <BackLink href="/dashboard/growth" label="Back to Growth" />;
}
