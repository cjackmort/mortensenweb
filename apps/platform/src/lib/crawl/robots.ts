/**
 * robots.txt, honoured rather than consulted.
 *
 * We are reading a business's site to build them something. Ignoring their
 * crawl directives while doing it would be both rude and, if it ever came up in
 * a sales conversation, indefensible. `site_audit_jobs.robots_respected`
 * defaults to true and this is what makes that column mean something.
 *
 * A deliberately small parser: `User-agent`, `Disallow`, `Allow`. No wildcards
 * beyond a trailing `*`, no crawl-delay, no sitemap directives. When a rule is
 * not understood the path is treated as **disallowed**, because guessing wrong
 * in the permissive direction is the failure that matters.
 */

export interface RobotsRules {
  /** Longest-match wins, which is the convention every major crawler follows. */
  disallow: string[];
  allow: string[];
}

export function parseRobots(body: string, userAgent = "*"): RobotsRules {
  const rules: RobotsRules = { disallow: [], allow: [] };

  let applies = false;
  let sawExactAgent = false;
  const wildcard: RobotsRules = { disallow: [], allow: [] };

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    const [rawKey, ...rest] = line.split(":");
    if (!rawKey || rest.length === 0) continue;

    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();

    if (key === "user-agent") {
      const agent = value.toLowerCase();
      applies = agent === userAgent.toLowerCase();
      if (applies) sawExactAgent = true;
      // A group for `*` is collected separately so a later exact-agent group
      // can take precedence without a second pass over the file.
      if (agent === "*") applies = true;
      continue;
    }

    if (key !== "disallow" && key !== "allow") continue;
    if (!applies) continue;

    const target = sawExactAgent ? rules : wildcard;
    if (key === "disallow" && value) target.disallow.push(value);
    if (key === "allow" && value) target.allow.push(value);
  }

  // The exact-agent group wins outright when there is one; otherwise `*`.
  if (rules.disallow.length === 0 && rules.allow.length === 0) return wildcard;
  return rules;
}

export function isAllowedByRobots(path: string, rules: RobotsRules): boolean {
  const allow = longestMatch(path, rules.allow);
  const disallow = longestMatch(path, rules.disallow);

  if (disallow === null) return true;
  // A tie goes to Allow, matching the convention — but only a genuine tie.
  if (allow !== null && allow >= disallow) return true;
  return false;
}

/** Length of the longest rule matching this path, or null if none match. */
function longestMatch(path: string, patterns: string[]): number | null {
  let best: number | null = null;

  for (const pattern of patterns) {
    const exact = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
    if (!path.startsWith(exact)) continue;
    if (best === null || exact.length > best) best = exact.length;
  }

  return best;
}
