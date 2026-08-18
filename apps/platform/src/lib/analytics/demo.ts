import type { AnalyticsSummary, RangeDays } from "./umami";

/**
 * Demo analytics.
 *
 * Exists so the dashboard's *design* can be judged before any real property is
 * connected. It is deterministic — seeded from the site id and the date — so
 * the numbers do not jitter on every refresh, which would make the charts look
 * broken rather than illustrative.
 *
 * Every surface that renders this MUST label it as demo. A plausible-looking
 * traffic chart that is actually invented is the single most misleading thing
 * this codebase could show a client, and the plan's rule that demo rows are
 * visibly labelled exists for exactly this case.
 */

/** Small deterministic PRNG: same seed, same series, every time. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFrom(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function demoAnalytics(
  siteKey: string,
  days: RangeDays,
): AnalyticsSummary {
  const random = mulberry32(seedFrom(`${siteKey}:${days}`));

  const series = [];
  let visitorsTotal = 0;
  let pageviewsTotal = 0;

  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date();
    day.setDate(day.getDate() - i);
    const dow = day.getDay();

    // A small local business: quiet weekends, a gentle upward drift.
    const weekend = dow === 0 || dow === 6 ? 0.55 : 1;
    const drift = 1 + ((days - i) / days) * 0.35;
    const visitors = Math.max(
      1,
      Math.round((6 + random() * 14) * weekend * drift),
    );
    const pageviews = Math.round(visitors * (1.8 + random() * 1.4));

    visitorsTotal += visitors;
    pageviewsTotal += pageviews;
    series.push({
      date: day.toISOString().slice(0, 10),
      visitors,
      pageviews,
    });
  }

  return {
    visitors: visitorsTotal,
    pageviews: pageviewsTotal,
    bounceRate: 0.38 + random() * 0.12,
    avgSecondsOnSite: Math.round(95 + random() * 70),
    series,
    topPages: [
      { label: "/", value: Math.round(pageviewsTotal * 0.42) },
      { label: "/gallery.html", value: Math.round(pageviewsTotal * 0.24) },
      { label: "/about.html", value: Math.round(pageviewsTotal * 0.14) },
      { label: "/process.html", value: Math.round(pageviewsTotal * 0.11) },
      { label: "/contact.html", value: Math.round(pageviewsTotal * 0.09) },
    ],
    referrers: [
      { label: "(direct)", value: Math.round(visitorsTotal * 0.46) },
      { label: "google.com", value: Math.round(visitorsTotal * 0.31) },
      { label: "instagram.com", value: Math.round(visitorsTotal * 0.16) },
      { label: "facebook.com", value: Math.round(visitorsTotal * 0.07) },
    ],
    devices: [
      { label: "mobile", value: Math.round(visitorsTotal * 0.61) },
      { label: "desktop", value: Math.round(visitorsTotal * 0.33) },
      { label: "tablet", value: Math.round(visitorsTotal * 0.06) },
    ],
    countries: [
      { label: "United States", value: Math.round(visitorsTotal * 0.88) },
      { label: "Canada", value: Math.round(visitorsTotal * 0.07) },
      { label: "United Kingdom", value: Math.round(visitorsTotal * 0.05) },
    ],
    // Shaped like a real artist's site: photographs dominate, and the calls
    // that follow are a fraction of them. A demo showing every event at a
    // similar height would teach the wrong thing about what the panel is for.
    events: [
      { label: "photo: Chief in Waiting", value: Math.round(visitorsTotal * 0.31) },
      { label: "photo: Bison Coat Rack", value: Math.round(visitorsTotal * 0.22) },
      { label: "photo: Mountain Lion", value: Math.round(visitorsTotal * 0.18) },
      { label: "photo: Coal Miner", value: Math.round(visitorsTotal * 0.11) },
      { label: "called", value: Math.round(visitorsTotal * 0.07) },
      { label: "emailed", value: Math.round(visitorsTotal * 0.04) },
    ],
    generatedAt: new Date(),
  };
}
