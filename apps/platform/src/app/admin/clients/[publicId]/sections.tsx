import Link from "next/link";

/**
 * The client page as a set of rooms rather than one long corridor.
 *
 * The overview shows who the client is and who can sign in, then one button
 * per setting. Each button opens that setting on its own — `?section=billing`
 * — so the operator goes straight to what they came for instead of scrolling
 * past everything else. The section lives in the URL, so a link to "this
 * client's billing" is something that can be bookmarked or sent.
 */

export const SECTIONS = [
  { key: "billing", title: "Billing", blurb: "Plan, payment day, invoices" },
  { key: "general", title: "General information", blurb: "What the website says about them" },
  { key: "website", title: "Website", blurb: "Repository, hosting, launch" },
  { key: "analytics", title: "Analytics", blurb: "Visitors over the last 30 days" },
  { key: "briefs", title: "What they asked for", blurb: "Call notes for the agent" },
  { key: "requests", title: "Requests", blurb: "Changes they've sent" },
] as const;

export type SectionKey = (typeof SECTIONS)[number]["key"];

export function sectionFrom(raw: string | undefined): SectionKey | null {
  return SECTIONS.find((section) => section.key === raw)?.key ?? null;
}

export type SectionSummaries = Record<SectionKey, { status: string; attention?: boolean }>;

/** The overview's grid: one button per setting, each with where it stands. */
export function SectionGrid({
  clientPublicId,
  summaries,
}: {
  clientPublicId: string;
  summaries: SectionSummaries;
}) {
  return (
    <nav className="section-grid" aria-label="Client settings">
      {SECTIONS.map((section) => {
        const summary = summaries[section.key];
        return (
          <Link
            key={section.key}
            href={`/admin/clients/${clientPublicId}?section=${section.key}`}
            className="section-tile"
          >
            <span className="section-tile-title">{section.title}</span>
            <span className="section-tile-blurb">{section.blurb}</span>
            <span className={`section-tile-status${summary.attention ? " needs-attention" : ""}`}>
              {summary.status}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

/** Inside a section: back to the overview, and a quick way across. */
export function SectionSwitcher({
  clientPublicId,
  current,
}: {
  clientPublicId: string;
  current: SectionKey;
}) {
  return (
    <nav className="section-switcher" aria-label="Client settings">
      <Link href={`/admin/clients/${clientPublicId}`} className="section-switcher-back">
        ← Overview
      </Link>
      {SECTIONS.map((section) => (
        <Link
          key={section.key}
          href={`/admin/clients/${clientPublicId}?section=${section.key}`}
          aria-current={section.key === current ? "page" : undefined}
        >
          {section.title}
        </Link>
      ))}
    </nav>
  );
}
