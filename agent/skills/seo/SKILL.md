---
name: seo
description: >
  This skill should be used when improving how a website ranks and appears in Google and other
  search engines — when the user asks to "improve SEO", "optimize for search", "add meta tags",
  "add structured data / schema", "fix Core Web Vitals", "why isn't my site ranking", "make a
  sitemap", "optimize for local search", or whenever site-builder ships a page. Covers
  technical SEO, on-page, schema.org, local SEO, performance, and an audit checklist.
metadata:
  version: "0.1.0"
---

# SEO

Ranking comes from three things this skill controls: crawlability and speed (technical), matching real search intent with clear page structure (on-page), and machine-readable meaning (structured data). Build these in; do not bolt them on. The full audit checklist and schema templates are in `references/checklist.md` and `references/schema.md`.

## 1. One page, one intent

Before writing a page, name its target query and intent: informational ("how much does a kitchen remodel cost"), commercial ("best kitchen remodeler Boise"), transactional ("book kitchen consultation"), navigational (brand). Each page targets one primary query + a cluster of close variants. Never make two pages compete for the same query — merge or differentiate.

For multi-page sites, plan a topical structure: Home (brand + main service), one page per service/product (commercial), location pages if multi-location (never thin duplicates — each needs unique local content), and a blog/guides section for informational queries that link *to* the service pages.

## 2. Head metadata (every page)

```html
<title>Primary Query Phrase — Brand</title>            <!-- 50–60 chars, query first -->
<meta name="description" content="…">                    <!-- 140–160 chars, includes query, ends with a reason to click -->
<link rel="canonical" href="https://example.com/path">   <!-- absolute, self-referencing, no query strings -->
<meta name="robots" content="index,follow,max-image-preview:large">
<meta property="og:title" content="…"><meta property="og:description" content="…">
<meta property="og:image" content="https://example.com/og/page.png"> <!-- 1200×630 -->
<meta property="og:url" content="…"><meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta name="viewport" content="width=device-width, initial-scale=1">
<html lang="en">
```
Astro: put these in `Base.astro` driven by props. Next.js: `export const metadata` / `generateMetadata` with `metadataBase` set once in the root layout.

## 3. Page structure

- Exactly one `<h1>` containing the primary query naturally.
- H2s are the sub-questions people actually search (use them verbatim where natural). H3s under them. No skipped levels.
- First 100 words state what the page is about and for whom.
- Semantic landmarks: `<header> <nav> <main> <article/section> <aside> <footer>`.
- Internal links: every page links to 3+ related pages with descriptive anchor text (not "click here"); every important page is reachable within 3 clicks from Home; breadcrumbs on multi-page sites (with `BreadcrumbList` schema).
- Images: descriptive filenames (`kitchen-remodel-boise-oak-cabinets.jpg`), `alt` that describes content (and includes the query only when true), `width`/`height`, modern formats (AVIF/WebP), `loading="lazy"` below the fold, `fetchpriority="high"` on the LCP image.
- Text is real HTML text, never baked into images. No content hidden behind tabs that only renders on click (hidden-by-CSS is fine; JS-injected-on-click is not).
- URLs: lowercase, hyphens, short, keyword-bearing, no dates, no stop words, no trailing slash inconsistency (pick one), no `index.html`.

## 4. Structured data (JSON-LD in `<head>`)

Always: `Organization` or `LocalBusiness` (site-wide, in the layout) + `WebSite`. Per page as applicable: `Service`, `Product` (+ `Offer`, `AggregateRating` only if real), `Article`/`BlogPosting`, `FAQPage` (only for visible FAQs), `BreadcrumbList`, `Person` (for personal brands), `Event`, `Recipe`, `HowTo`, `VideoObject`. Templates in `references/schema.md`. Never mark up content that is not visible on the page. Validate with the Rich Results Test / Schema Markup Validator mentally: required properties present, absolute URLs, ISO dates.

## 5. Local SEO (any business with a location or service area)

- NAP (name, address, phone) identical everywhere: footer, contact page, `LocalBusiness` schema, Google Business Profile.
- `LocalBusiness` subtype (e.g. `Plumber`, `Restaurant`, `Dentist`) with `address`, `geo`, `openingHoursSpecification`, `telephone`, `priceRange`, `areaServed`, `sameAs` (social profiles).
- City + service in title/H1 of the relevant page ("Emergency Plumber in Boise, ID").
- An embedded or linked map, driving directions, real photos of the premises (flag in ASSETS-TO-REPLACE — these matter more than stock).
- One page per distinct service and per distinct location when content can be unique; otherwise a single "Areas we serve" page.

## 6. Crawl files

`robots.txt`: allow all, point to sitemap; disallow only admin/search/param URLs. `sitemap.xml`: every indexable URL with `lastmod`; Astro `@astrojs/sitemap`, Next `app/sitemap.ts`. Exclude thank-you pages, tag archives, paginated duplicates. Submit in Google Search Console after launch.

## 7. Performance = ranking + retention

Targets (mobile, lab): LCP < 2.5s, INP < 200ms, CLS < 0.1, total JS < 150KB gzipped for a marketing site, Lighthouse ≥ 90 across the board. How: static generation, preload the hero image and display font, `font-display: swap` with metric fallbacks, inline critical CSS (Astro does this), defer all non-critical JS, no third-party scripts above the fold, image dimensions everywhere, `content-visibility: auto` on long below-fold sections, cache headers (`_headers` on Netlify: immutable for hashed assets).

## 8. Retention signals

Search engines watch pogo-sticking. Reduce it: answer the query in the first screen, keep the CTA visible, use a sticky or easy-to-reach nav, add related links at the bottom of every page, make pages fast on 3G, avoid interstitials and cookie walls that cover content (a small bottom bar is fine).

## 9. Audit mode

When asked to audit an existing site: fetch the page(s), run through `references/checklist.md`, and report findings as **Critical / Important / Nice-to-have** with the exact fix for each. Spawn the `search-visibility-auditor` agent for a multi-page crawl. Check for: missing/duplicate titles, thin pages, broken links, redirect chains, noindex leaks, missing canonical, mixed content, slow LCP, missing alt, orphan pages, missing schema, and mismatched NAP.

## Output

During builds: emit the head block, JSON-LD, robots/sitemap, and the performance settings in the stack's idiom. During audits: the prioritized findings list with fixes.
