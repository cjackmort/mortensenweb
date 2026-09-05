# SEO Audit Checklist

Work top to bottom. Mark each item Pass / Fail / N/A with the exact fix.

## Crawl & index
- [ ] `robots.txt` present, allows main content, references sitemap
- [ ] `sitemap.xml` valid, only indexable 200 URLs, `lastmod` accurate
- [ ] No accidental `noindex` (meta or `X-Robots-Tag`) on money pages
- [ ] One canonical per page, absolute, self-referencing, matches the served URL (scheme, host, trailing slash)
- [ ] www / non-www and http → https redirect to a single host with 301
- [ ] No redirect chains (>1 hop) or loops; no soft-404s (200 with "not found" content)
- [ ] 404 page returns a real 404 status and links back into the site
- [ ] Pagination/filters do not create infinite crawl paths (use canonical or `noindex` on param URLs)
- [ ] Orphan pages: every indexable page has ≥1 internal link

## Head
- [ ] Unique `<title>` 50–60 chars, query first, brand last
- [ ] Unique meta description 140–160 chars
- [ ] `lang` attribute, viewport meta, favicon
- [ ] OG + Twitter tags with a 1200×630 image that exists
- [ ] Hreflang if multilingual (reciprocal, includes `x-default`)

## Content
- [ ] One H1 per page, contains the primary query
- [ ] Logical heading outline (no skipped levels, H2s = searched sub-questions)
- [ ] ≥ 300 words of unique, useful text on any page meant to rank (service pages 600–1200)
- [ ] First screen answers "what / for whom / do what next"
- [ ] No duplicate or near-duplicate pages (location pages especially)
- [ ] Descriptive anchor text on internal links; 3+ internal links per page; breadcrumbs on deep pages
- [ ] Outbound links to authoritative sources where relevant (with `rel` as appropriate)
- [ ] Author/business info visible (E-E-A-T): about page, contact details, real names where appropriate

## Images & media
- [ ] Every `<img>` has `alt` (empty `alt=""` for decorative), `width` and `height`
- [ ] Modern formats (AVIF/WebP) with fallbacks; hero image preloaded, not lazy
- [ ] Descriptive filenames; no text-in-images for essential content
- [ ] Videos have poster, captions/transcript when they carry content

## Structured data
- [ ] Site-wide `Organization`/`LocalBusiness` + `WebSite`
- [ ] Page-type schema (Service/Product/Article/FAQ/Event/Breadcrumb) with required fields
- [ ] No schema for invisible content; no fake ratings
- [ ] JSON parses; URLs absolute; dates ISO 8601

## Local
- [ ] NAP identical across footer, contact page, schema, GBP
- [ ] City/service in title/H1 of local pages; map + directions; opening hours
- [ ] `areaServed` and `openingHoursSpecification` in schema

## Performance (mobile)
- [ ] LCP < 2.5s, INP < 200ms, CLS < 0.1
- [ ] Critical CSS inline; fonts `display: swap` + metric fallback; ≤ 4 font files
- [ ] JS ≤ 150KB gz on marketing pages; third-party scripts deferred/lazy
- [ ] Cache headers: hashed assets immutable, HTML short/no-cache
- [ ] Compression (Brotli/gzip) on; HTTP/2 or 3
- [ ] No layout shift from ads, embeds, late fonts, or entrance animations

## Security & trust
- [ ] HTTPS everywhere, no mixed content, HSTS
- [ ] Security headers (`X-Content-Type-Options`, `Referrer-Policy`, CSP where feasible)
- [ ] Privacy policy / terms linked in footer; cookie consent only if actually needed and not content-blocking

## Post-launch
- [ ] Search Console verified, sitemap submitted, coverage checked after 7 days
- [ ] GBP updated with new URL; social profiles updated
- [ ] Analytics with conversion events (form submit, call click, booking)
- [ ] Re-crawl with a link checker; monitor 404s and fix with redirects
