import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  activeHref,
  backTargetFor,
  isSectionRoot,
  nextCameFrom,
  returnTargetFor,
  transitionFor,
} from "@/components/shell-routes";
import { ADMIN_NAV, clientNav } from "@/components/shell-nav";
import { NO_CLIENT_SECTIONS } from "@/db/repositories/client/sections";

/**
 * The portal's two kinds of screen: a section root keeps the top bar and the
 * tabs, and every page below one is a focused screen with a single way back.
 * These are the rules that decide which is which and where "back" goes.
 */

const CLIENT = clientNav(NO_CLIENT_SECTIONS, 0);
const STORE_CLIENT = clientNav({ ...NO_CLIENT_SECTIONS, shop: true }, 0);
const EVERY_CLIENT_TAB = clientNav({ getStarted: true, availability: true, shop: true }, 0);

describe("isSectionRoot", () => {
  it("treats every tab the person has as a root", () => {
    expect(isSectionRoot("/dashboard", CLIENT)).toBe(true);
    expect(isSectionRoot("/dashboard/growth", CLIENT)).toBe(true);
    expect(isSectionRoot("/admin/clients", ADMIN_NAV)).toBe(true);
  });

  it("treats a page below a tab as a sub-page", () => {
    expect(isSectionRoot("/dashboard/growth/leads", CLIENT)).toBe(false);
    expect(isSectionRoot("/dashboard/profile", CLIENT)).toBe(false);
    expect(isSectionRoot("/admin/clients/abc123", ADMIN_NAV)).toBe(false);
  });

  it("makes the shop a root only for a client whose shop tab is on", () => {
    expect(isSectionRoot("/dashboard/growth/shop", STORE_CLIENT)).toBe(true);
    expect(isSectionRoot("/dashboard/growth/shop", CLIENT)).toBe(false);
  });

  it("ignores a trailing slash", () => {
    expect(isSectionRoot("/dashboard/growth/", CLIENT)).toBe(true);
  });
});

describe("backTargetFor", () => {
  it("returns null on a section root, which has no back button", () => {
    expect(backTargetFor("/dashboard", CLIENT)).toBeNull();
    expect(backTargetFor("/dashboard/growth", CLIENT)).toBeNull();
    expect(backTargetFor("/admin", ADMIN_NAV)).toBeNull();
  });

  it("goes up one level to the parent page, named after it", () => {
    expect(backTargetFor("/dashboard/growth/leads", CLIENT)).toEqual({
      href: "/dashboard/growth",
      label: "Growth",
    });
    expect(backTargetFor("/dashboard/growth/leads/abc123", CLIENT)).toEqual({
      href: "/dashboard/growth/leads",
      label: "Leads",
    });
    expect(backTargetFor("/admin/clients/abc123", ADMIN_NAV)).toEqual({
      href: "/admin/clients",
      label: "Clients",
    });
  });

  it("names a page by what it is when its path is an id", () => {
    expect(backTargetFor("/dashboard/growth/ads/abc123/edit", CLIENT)).toEqual({
      href: "/dashboard/growth/ads/abc123",
      label: "Ad",
    });
  });

  it("prefers a literal segment over an id when naming", () => {
    expect(backTargetFor("/admin/clients/potential/new", ADMIN_NAV)).toEqual({
      href: "/admin/clients",
      label: "Clients",
    });
  });

  it("skips a folder that is not a page", () => {
    expect(backTargetFor("/dashboard/growth/shop/products/new", STORE_CLIENT)).toEqual({
      href: "/dashboard/growth/shop",
      label: "Shop",
    });
    expect(backTargetFor("/admin/clients/potential/abc123", ADMIN_NAV)).toEqual({
      href: "/admin/clients",
      label: "Clients",
    });
  });

  it("sends an admin report back to the client's reports, not the client overview", () => {
    expect(backTargetFor("/admin/clients/abc123/reports/2026-09", ADMIN_NAV)).toEqual({
      href: "/admin/clients/abc123?section=reports",
      label: "Monthly reports",
    });
  });

  it("sends the shop back to Growth for a client without the shop tab", () => {
    expect(backTargetFor("/dashboard/growth/shop", CLIENT)).toEqual({
      href: "/dashboard/growth",
      label: "Growth",
    });
  });

  it("sends a page that is under no tab to the section home", () => {
    expect(backTargetFor("/dashboard/profile", CLIENT)).toEqual({
      href: "/dashboard",
      label: "Your site",
    });
    expect(backTargetFor("/admin/mortensenweb", ADMIN_NAV)).toEqual({
      href: "/admin",
      label: "Overview",
    });
  });
});

describe("returnTargetFor", () => {
  it("sends a page under no tab back to the page it was opened from", () => {
    expect(returnTargetFor("/dashboard/profile", CLIENT, "/dashboard/growth/leads")).toEqual({
      href: "/dashboard/growth/leads",
      label: "Leads",
    });
    expect(returnTargetFor("/dashboard/connections", CLIENT, "/dashboard/reports")).toEqual({
      href: "/dashboard/reports",
      label: "Reports",
    });
  });

  it("falls back to the section home when nothing is known about the way in", () => {
    expect(returnTargetFor("/dashboard/profile", CLIENT, null)).toEqual({
      href: "/dashboard",
      label: "Your site",
    });
  });

  it("never points a page back at itself", () => {
    expect(returnTargetFor("/dashboard/profile", CLIENT, "/dashboard/profile")).toEqual({
      href: "/dashboard",
      label: "Your site",
    });
  });

  it("never leaves the area the page is in", () => {
    expect(returnTargetFor("/dashboard/profile", CLIENT, "/admin/clients")).toEqual({
      href: "/dashboard",
      label: "Your site",
    });
  });

  it("keeps the structural parent for a page under a tab, wherever it was opened from", () => {
    expect(returnTargetFor("/dashboard/growth/leads/abc123", CLIENT, "/dashboard/requests")).toEqual({
      href: "/dashboard/growth/leads",
      label: "Leads",
    });
  });

  it("has no target on a section root", () => {
    expect(returnTargetFor("/dashboard/growth", CLIENT, "/dashboard/profile")).toBeNull();
  });
});

describe("nextCameFrom", () => {
  it("remembers the page a side trip started from", () => {
    expect(nextCameFrom("/dashboard/growth", "/dashboard/profile", null, CLIENT)).toBe(
      "/dashboard/growth",
    );
  });

  it("keeps the starting page while moving between pages under no tab", () => {
    expect(
      nextCameFrom("/dashboard/profile", "/dashboard/connections", "/dashboard/growth", CLIENT),
    ).toBe("/dashboard/growth");
  });

  it("forgets it once the side trip is over", () => {
    expect(
      nextCameFrom("/dashboard/profile", "/dashboard/growth/leads", "/dashboard/growth", CLIENT),
    ).toBeNull();
  });

  it("changes nothing when the path did not change", () => {
    expect(
      nextCameFrom("/dashboard/profile", "/dashboard/profile", "/dashboard/growth", CLIENT),
    ).toBe("/dashboard/growth");
  });
});

describe("transitionFor", () => {
  it("does not animate switching tabs", () => {
    expect(transitionFor("/dashboard", "/dashboard/growth", CLIENT)).toBe("none");
  });

  it("opens a sub-page forwards", () => {
    expect(transitionFor("/dashboard/growth", "/dashboard/growth/leads", CLIENT)).toBe("forward");
    expect(transitionFor("/dashboard/growth/leads", "/dashboard/growth/leads/abc", CLIENT)).toBe(
      "forward",
    );
    expect(transitionFor("/dashboard", "/dashboard/profile", CLIENT)).toBe("forward");
  });

  it("closes a sub-page backwards", () => {
    expect(transitionFor("/dashboard/growth/leads/abc", "/dashboard/growth/leads", CLIENT)).toBe(
      "back",
    );
    expect(transitionFor("/dashboard/profile", "/dashboard/growth", CLIENT)).toBe("back");
  });

  it("does not animate when only the query changed", () => {
    expect(transitionFor("/dashboard/profile", "/dashboard/profile", CLIENT)).toBe("none");
  });
});

describe("activeHref", () => {
  const clientHrefs = CLIENT.map((item) => item.href);
  const adminHrefs = ADMIN_NAV.map((item) => item.href);

  it("never lights the section home for a page that is not the home", () => {
    expect(activeHref("/dashboard/profile", clientHrefs)).toBeUndefined();
    expect(activeHref("/dashboard/connections", clientHrefs)).toBeUndefined();
    expect(activeHref("/admin/mortensenweb", adminHrefs)).toBeUndefined();
  });

  it("lights the home on the home itself", () => {
    expect(activeHref("/dashboard", clientHrefs)).toBe("/dashboard");
    expect(activeHref("/admin", adminHrefs)).toBe("/admin");
  });

  it("lights the most specific tab a page sits under", () => {
    expect(activeHref("/dashboard/growth/leads", clientHrefs)).toBe("/dashboard/growth");
    expect(activeHref("/admin/clients/abc123", adminHrefs)).toBe("/admin/clients");
    expect(
      activeHref(
        "/dashboard/growth/shop/orders",
        STORE_CLIENT.map((item) => item.href),
      ),
    ).toBe("/dashboard/growth/shop");
  });
});

/*
 * Every page in the portal, read from the file system, so a page added later
 * is checked without anyone remembering to list it here.
 */
const APP_DIR = fileURLToPath(new URL("../src/app", import.meta.url));

function pageRoutes(area: string): string[] {
  const root = join(APP_DIR, area);
  const routes: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "page.tsx") {
        const segments = relative(APP_DIR, dir)
          .split(sep)
          // Route groups — `(name)` — are folders, not URL segments.
          .filter((segment) => !/^\(.+\)$/.test(segment));
        routes.push(`/${segments.join("/")}`);
      }
    }
  };
  walk(root);
  return routes.sort();
}

const PAGES = [...pageRoutes("dashboard"), ...pageRoutes("admin")];

/** `/admin/clients/[publicId]` → `/admin/clients/sample-id` */
function samplePath(route: string): string {
  return route.replace(/\[\.{0,3}[^\]]+\]/g, "sample-id");
}

/**
 * Resolves a URL the way the router does — a folder named for the segment
 * beats a `[param]` folder — and says whether it lands on a `page.tsx`.
 * Matching against the page list alone would let `/admin/clients/potential`
 * pass as a client id, when it is a folder with no page of its own.
 */
function isAPage(href: string): boolean {
  const [path = ""] = href.split("?");
  const segments = path.split("/").filter(Boolean);
  let dir = APP_DIR;
  for (const segment of segments) {
    const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    const next =
      entries.find((e) => e.name === segment) ??
      entries.find((e) => e.name.startsWith("[") && !e.name.startsWith("[["));
    if (!next) return false;
    dir = join(dir, next.name);
  }
  return readdirSync(dir).includes("page.tsx");
}

describe("every page in the portal", () => {
  it("finds the pages", () => {
    expect(PAGES).toContain("/dashboard/growth/leads/[publicId]");
    expect(PAGES).toContain("/admin/clients/[publicId]");
  });

  it.each([
    ["client without optional tabs", CLIENT, "dashboard"],
    ["client with every optional tab", EVERY_CLIENT_TAB, "dashboard"],
    ["admin", ADMIN_NAV, "admin"],
  ] as const)("is a root or has a back target that is a real page (%s)", (_, roots, area) => {
    for (const route of PAGES.filter((r) => r.startsWith(`/${area}`))) {
      const path = samplePath(route);
      if (isSectionRoot(path, roots)) continue;
      const target = backTargetFor(path, roots);
      expect(target, route).not.toBeNull();
      expect(isAPage(target!.href), `${route} → ${target!.href}`).toBe(true);
      // Named after where it goes, never the generic fallback.
      expect(target!.label, `${route} → ${target!.href}`).not.toBe("Back");
    }
  });

  it("has a tab for every root, and every tab is a real page or an optional one", () => {
    for (const item of [...EVERY_CLIENT_TAB, ...ADMIN_NAV]) {
      const optional = ["/dashboard/get-started", "/dashboard/availability"].includes(item.href);
      if (!optional) expect(isAPage(item.href), item.href).toBe(true);
    }
  });
});
