/**
 * Turning a page into attributed facts.
 *
 * Two rules govern everything here, and they come from Stage 0 §7.2 and §13.2.
 *
 * **Crawled text is data.** Nothing extracted here is ever concatenated into an
 * instruction for an agent. Facts carry a `sourceUrl` and are shown to an
 * operator to accept or reject; the generator reads only what was accepted.
 *
 * **Facts, never design.** This reads what a business *is* — name, phone,
 * hours, services — and deliberately does not capture markup, CSS, or layout.
 * We are not copying anyone's website, and there is no code path here that
 * could, because nothing retains the structure it read.
 *
 * The parsing is regex over HTML, which is normally a mistake. It is the right
 * call here: the input is arbitrary broken markup from the open web, a real
 * parser is a dependency shipped into a serverless function for a handful of
 * fields, and every extraction is provisional anyway — an operator confirms it
 * before it can reach a generated page.
 */

export interface ExtractedPage {
  title: string | null;
  metaDescription: string | null;
  h1: string | null;
  canonical: string | null;
  /** Same-origin links, for the crawl frontier. */
  links: string[];
  text: string;
}

export interface ExtractedFact {
  key: string;
  value: string;
  /**
   * Claims that must never be auto-published: licence and insurance numbers,
   * certifications, warranties, pricing, awards, years in business. Stored so
   * an operator can confirm them from a source we trust, never rendered on the
   * strength of having read them somewhere.
   */
  sensitive: boolean;
  confidence: number;
}

const SENSITIVE_KEYS = new Set([
  "licence_number",
  "insurance",
  "certification",
  "warranty",
  "pricing",
  "award",
  "years_in_business",
  "review_count",
  "rating",
  "staff",
]);

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key);
}

const stripTags = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();

const attr = (tag: string, name: string): string | null => {
  const match = new RegExp(String.raw`${name}\s*=\s*["']([^"']*)["']`, "i").exec(
    tag,
  );
  return match?.[1]?.trim() || null;
};

export function extractPage(html: string, pageUrl: string): ExtractedPage {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];

  let metaDescription: string | null = null;
  let canonical: string | null = null;

  for (const tag of html.match(/<meta[^>]*>/gi) ?? []) {
    if (/name\s*=\s*["']description["']/i.test(tag)) {
      metaDescription = attr(tag, "content");
      break;
    }
  }

  for (const tag of html.match(/<link[^>]*>/gi) ?? []) {
    if (/rel\s*=\s*["']canonical["']/i.test(tag)) {
      canonical = attr(tag, "href");
      break;
    }
  }

  const links: string[] = [];
  const origin = safeOrigin(pageUrl);

  for (const tag of html.match(/<a[^>]*>/gi) ?? []) {
    const href = attr(tag, "href");
    if (!href || href.startsWith("#")) continue;

    try {
      const resolved = new URL(href, pageUrl);
      // Same origin only. Following outward turns a bounded audit of one
      // business into an unbounded crawl of the web.
      if (origin && resolved.origin === origin) {
        resolved.hash = "";
        links.push(resolved.toString());
      }
    } catch {
      // A malformed href on someone else's page is not our problem.
    }
  }

  return {
    title: title ? stripTags(title) : null,
    metaDescription,
    h1: h1 ? stripTags(h1) : null,
    canonical,
    links: [...new Set(links)],
    text: stripTags(html).slice(0, 20_000),
  };
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Facts a page asserts about the business.
 *
 * Confidence is coarse on purpose — it orders the operator's review queue and
 * nothing else. It never decides whether something is published; only an
 * operator's acceptance does that.
 */
export function extractFacts(page: ExtractedPage, html: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const byIdentity = new Map<string, number>();

  const add = (key: string, value: string | null | undefined, confidence: number) => {
    const cleaned = (value ?? "").replace(/\s+/g, " ").trim();
    if (!cleaned) return;

    const identity = `${key}:${normaliseForComparison(key, cleaned)}`;
    const existing = byIdentity.get(identity);

    if (existing !== undefined) {
      // The same fact found twice. Keep whichever source we trust more rather
      // than whichever we happened to read first — a phone number in JSON-LD
      // and the same one in a tel: link are one fact, and the operator should
      // review it once, in its better-attested form.
      const incumbent = facts[existing];
      if (incumbent && confidence > incumbent.confidence) {
        facts[existing] = {
          key,
          value: cleaned.slice(0, 500),
          sensitive: isSensitiveKey(key),
          confidence,
        };
      }
      return;
    }

    byIdentity.set(identity, facts.length);
    facts.push({
      key,
      value: cleaned.slice(0, 500),
      sensitive: isSensitiveKey(key),
      confidence,
    });
  };

  add("page_title", page.title, 70);
  add("meta_description", page.metaDescription, 70);
  add("headline", page.h1, 60);

  // A phone number in a `tel:` link is asserted by the site as a way to reach
  // them, which is far stronger evidence than a digit run in body copy.
  for (const tag of html.match(/<a[^>]*href\s*=\s*["']tel:[^"']*["'][^>]*>/gi) ?? []) {
    add("phone", attr(tag, "href")?.replace(/^tel:/i, ""), 90);
  }

  for (const tag of html.match(/<a[^>]*href\s*=\s*["']mailto:[^"']*["'][^>]*>/gi) ?? []) {
    add("email", attr(tag, "href")?.replace(/^mailto:/i, "").split("?")[0], 90);
  }

  // Schema.org markup is the business describing itself in a machine-readable
  // way, so it is the most trustworthy thing on the page.
  for (const block of html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) ?? []) {
    const json = /<script[^>]*>([\s\S]*?)<\/script>/i.exec(block)?.[1];
    if (!json) continue;
    try {
      collectFromJsonLd(JSON.parse(json), add);
    } catch {
      // Invalid JSON-LD is extremely common and not worth reporting.
    }
  }

  return facts;
}

/**
 * Are these two readings the same fact?
 *
 * Formatting differs between where a site states something and where it links
 * it — `+1-303-555-0100` in structured data, `+13035550100` in a `tel:` href.
 * Comparing the raw strings shows the operator the same number twice and
 * teaches them the review queue is padded, which is how a review queue stops
 * being read.
 */
function normaliseForComparison(key: string, value: string): string {
  if (key === "phone") return value.replace(/[^0-9]/g, "");
  if (key === "email") return value.toLowerCase();
  return value.toLowerCase();
}

type AddFact = (key: string, value: string | null | undefined, confidence: number) => void;

function collectFromJsonLd(node: unknown, add: AddFact): void {
  if (Array.isArray(node)) {
    for (const item of node) collectFromJsonLd(item, add);
    return;
  }
  if (!node || typeof node !== "object") return;

  const record = node as Record<string, unknown>;
  const str = (value: unknown): string | null =>
    typeof value === "string" ? value : null;

  add("business_name", str(record.name), 95);
  add("phone", str(record.telephone), 95);
  add("email", str(record.email), 95);

  const address = record.address as Record<string, unknown> | undefined;
  if (address && typeof address === "object") {
    add("street_address", str(address.streetAddress), 90);
    add("locality", str(address.addressLocality), 90);
    add("region", str(address.addressRegion), 90);
    add("postal_code", str(address.postalCode), 90);
  }

  const hours = record.openingHours;
  if (typeof hours === "string") add("opening_hours", hours, 85);
  if (Array.isArray(hours)) {
    for (const entry of hours) add("opening_hours", str(entry), 85);
  }

  for (const value of Object.values(record)) {
    if (value && typeof value === "object") collectFromJsonLd(value, add);
  }
}
