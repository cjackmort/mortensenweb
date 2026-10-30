/**
 * Which kind of screen a portal path is, and where its back button goes.
 *
 * The portal has two kinds of screen. A section root — a path that is one of
 * the tabs the person has — shows the top bar and the tabs. Every page below
 * one is a focused screen: the chrome goes, and a single back button takes
 * its place, the way a phone app opens a screen over the list it came from.
 *
 * Pure functions of the path, with no React and no router, so the shell can
 * decide on the client (a `loading.tsx` skeleton renders in the right mode
 * too) and the rules can be tested against every page on disk.
 */

export interface ShellLink {
  href: string;
  label: string;
}

/** What the page wrapper does as the path changes. */
export type ShellTransition = "forward" | "back" | "none";

/** Shown when a destination has no name in `LABELS`. The tests forbid it for any real back target. */
const FALLBACK_LABEL = "Back";

const WILDCARD = "*";

/*
 * Folders that hold pages without being one. A back button walking up the
 * path skips them: `/dashboard/growth/shop/products/new` goes to the shop,
 * because there is no list at `/products` to go to.
 */
const NOT_PAGES: readonly string[] = [
  "/dashboard/growth/shop/products",
  "/admin/clients/potential",
  "/admin/clients/*/reports",
];

/*
 * Back targets that are more than the nearest page above. A monthly report is
 * opened from the client's "Monthly reports" section, so that is where it
 * returns — the client overview would make the operator find it again.
 */
const OVERRIDES: readonly { pattern: string; target: (segments: string[]) => ShellLink }[] = [
  {
    pattern: "/admin/clients/*/reports/*",
    target: (segments) => ({
      href: `/admin/clients/${segments[2]}?section=reports`,
      label: "Monthly reports",
    }),
  },
];

/*
 * What each page is called on a back button: its own name, short. A `*` is an
 * id, so the page is named by what it is ("Lead"), not who it is — the shell
 * cannot know a lead's name without a database read it should not make.
 * A tab's own label (from the nav) wins over these.
 */
const LABELS: Readonly<Record<string, string>> = {
  "/dashboard": "Your site",
  "/dashboard/get-started": "Get started",
  "/dashboard/availability": "Availability",
  "/dashboard/growth": "Growth",
  "/dashboard/growth/leads": "Leads",
  "/dashboard/growth/leads/*": "Lead",
  "/dashboard/growth/ads": "Ads",
  "/dashboard/growth/ads/*": "Ad",
  "/dashboard/growth/ads/*/edit": "Edit ad",
  "/dashboard/growth/ads/*/channels": "Channels",
  "/dashboard/growth/ads/*/checkout": "Checkout",
  "/dashboard/growth/campaigns": "Campaigns",
  "/dashboard/growth/campaigns/new": "New campaign",
  "/dashboard/growth/campaigns/*": "Campaign",
  "/dashboard/growth/google": "Google profile",
  "/dashboard/growth/reviews": "Review requests",
  "/dashboard/growth/reviews/settings": "Review settings",
  "/dashboard/growth/search": "Search",
  "/dashboard/growth/shop": "Shop",
  "/dashboard/growth/shop/orders": "Orders",
  "/dashboard/growth/shop/settings": "Shop settings",
  "/dashboard/growth/shop/products/new": "Add a product",
  "/dashboard/growth/shop/products/*": "Product",
  "/dashboard/growth/showcase": "Job showcase",
  "/dashboard/growth/showcase/new": "New job",
  "/dashboard/growth/showcase/*": "Job",
  "/dashboard/growth/winback": "Win-back emails",
  "/dashboard/growth/winback/customers": "Past customers",
  "/dashboard/growth/winback/*": "Win-back email",
  "/dashboard/listings": "Get listed",
  "/dashboard/requests": "Requests",
  "/dashboard/media": "Media",
  "/dashboard/reports": "Reports",
  "/dashboard/reports/*": "Report",
  "/dashboard/plan": "Plan",
  "/dashboard/choose-plan": "Choose a plan",
  "/dashboard/billing": "Billing",
  "/dashboard/profile": "Profile",
  "/dashboard/connections": "Connections",
  "/admin": "Overview",
  "/admin/clients": "Clients",
  "/admin/clients/new": "Add a client",
  "/admin/clients/*": "Client",
  "/admin/clients/potential/new": "Add a potential client",
  "/admin/clients/potential/*": "Potential client",
  "/admin/clients/*/reports/*": "Report",
  "/admin/requests": "Requests",
  "/admin/showcases": "Showcases",
  "/admin/payments": "Payments",
  "/admin/ads": "Ads",
  "/admin/ads/*": "Ad",
  "/admin/google": "Google",
  "/admin/google/*": "Google profile",
  "/admin/winback": "Win-back",
  "/admin/mortensenweb": "MortensenWeb",
  "/admin/prospects": "Prospects",
};

function segmentsOf(path: string): string[] {
  const [beforeQuery = ""] = path.split("?");
  return beforeQuery.split("/").filter(Boolean);
}

/** `/dashboard/growth/` → `/dashboard/growth`. The router never adds one; a typed URL might. */
function normalize(path: string): string {
  return `/${segmentsOf(path).join("/")}`;
}

function matches(pattern: string, segments: readonly string[]): boolean {
  const parts = segmentsOf(pattern);
  return (
    parts.length === segments.length &&
    parts.every((part, i) => part === WILDCARD || part === segments[i])
  );
}

/** `/dashboard` or `/admin`: the home every path in that half of the portal falls back to. */
function areaHomeOf(path: string): string {
  return `/${segmentsOf(path)[0] ?? ""}`;
}

/** A path's name, preferring the pattern with the most literal segments: `clients/new` over `clients/*`. */
function labelFor(href: string, roots: readonly ShellLink[]): string {
  const path = normalize(href);
  const root = roots.find((item) => item.href === path);
  if (root) return root.label;

  const segments = segmentsOf(path);
  const literals = (pattern: string) =>
    segmentsOf(pattern).filter((part) => part !== WILDCARD).length;
  const best = Object.keys(LABELS)
    .filter((pattern) => matches(pattern, segments))
    .sort((a, b) => literals(b) - literals(a))[0];
  return (best && LABELS[best]) ?? FALLBACK_LABEL;
}

/** True on a path that is one of the person's tabs: the top bar and tabs stay. */
export function isSectionRoot(pathname: string, roots: readonly ShellLink[]): boolean {
  const path = normalize(pathname);
  return roots.some((item) => item.href === path);
}

/**
 * Where a sub-page's back button goes: the nearest page above it, named after
 * that page. Null on a section root, which has no back button.
 */
export function backTargetFor(pathname: string, roots: readonly ShellLink[]): ShellLink | null {
  if (isSectionRoot(pathname, roots)) return null;
  const segments = segmentsOf(pathname);
  if (segments.length <= 1) return null;

  const override = OVERRIDES.find((entry) => matches(entry.pattern, segments));
  if (override) return override.target(segments);

  // Walks up one segment at a time. Depth 1 is the area home, which is always
  // a page, so the loop always returns.
  for (let depth = segments.length - 1; depth >= 1; depth--) {
    const candidate = segments.slice(0, depth);
    if (NOT_PAGES.some((pattern) => matches(pattern, candidate))) continue;
    const href = `/${candidate.join("/")}`;
    return { href, label: labelFor(href, roots) };
  }
  return null;
}

/**
 * A page that sits under no tab — profile, connections, choose-plan — whose
 * nearest page above is just the section home. It is reached from anywhere,
 * so "up" means little; it goes back to where it was opened from instead.
 */
function isUnderNoTab(pathname: string, roots: readonly ShellLink[]): boolean {
  return backTargetFor(pathname, roots)?.href === areaHomeOf(pathname);
}

/**
 * The back button actually shown. A page under a tab always goes to its parent,
 * whatever link opened it, so the button means the same thing every time. A
 * page under no tab goes back to `cameFrom`, the page it was opened from.
 *
 * It is a link to that page rather than `history.back()`. History would often
 * be wrong here: after a form saves and redirects to `?saved=1` the entry
 * behind is the same page, and after a Google sign-in round trip it is
 * Google. A link goes where its label says, every time.
 */
export function returnTargetFor(
  pathname: string,
  roots: readonly ShellLink[],
  cameFrom: string | null,
): ShellLink | null {
  const target = backTargetFor(pathname, roots);
  if (!target || !cameFrom || !isUnderNoTab(pathname, roots)) return target;

  const from = normalize(cameFrom);
  if (from === normalize(pathname) || areaHomeOf(from) !== areaHomeOf(pathname)) return target;
  return { href: from, label: labelFor(from, roots) };
}

/**
 * The page a side trip started from, carried from one navigation to the next.
 * Set on the way into a page under no tab, kept while moving between such
 * pages (profile → connections still returns to where the trip began, so two
 * of them never send each other back and forth), and cleared once it is over.
 */
export function nextCameFrom(
  previousPath: string,
  nextPath: string,
  cameFrom: string | null,
  roots: readonly ShellLink[],
): string | null {
  if (normalize(previousPath) === normalize(nextPath)) return cameFrom;
  if (!isUnderNoTab(nextPath, roots)) return null;
  return isUnderNoTab(previousPath, roots) ? cameFrom : normalize(previousPath);
}

/**
 * Which way the page slides as the path changes. Switching tabs does not move
 * at all, as before; opening a sub-page comes in from the right, and closing
 * one — to its parent or to any section root — comes in from the left.
 */
export function transitionFor(
  from: string,
  to: string,
  roots: readonly ShellLink[],
): ShellTransition {
  const previous = normalize(from);
  const next = normalize(to);
  if (previous === next) return "none";

  const fromRoot = isSectionRoot(previous, roots);
  const toRoot = isSectionRoot(next, roots);
  if (fromRoot && toRoot) return "none";
  if (toRoot) return "back";
  if (fromRoot) return "forward";
  return previous.startsWith(`${next}/`) ? "back" : "forward";
}

/**
 * The tab to mark as current, if any.
 *
 * Only the most specific match is active, so `/admin/clients/abc` lights
 * Clients and not Overview too. And a section home — `/dashboard`, `/admin` —
 * is active only on itself: every client page starts with `/dashboard/`, so
 * prefix-matching it lit "Your site" on the profile page, which is not part
 * of the site at all.
 */
export function activeHref(pathname: string, hrefs: readonly string[]): string | undefined {
  const path = normalize(pathname);
  if (hrefs.includes(path)) return path;
  return hrefs
    .filter((href) => segmentsOf(href).length > 1 && path.startsWith(`${href}/`))
    .sort((a, b) => b.length - a.length)[0];
}
