---
name: geo
description: >
  This skill should be used when making a website visible and citable in AI answers — when the
  user asks about "GEO", "generative engine optimization", "show up in ChatGPT / Perplexity /
  Google AI Overviews / Claude answers", "AI search", "llms.txt", "get cited by AI", "answer
  engine optimization / AEO", or whenever site-builder ships content pages. Covers answer-first
  content structure, entity clarity, citation-worthiness, llms.txt, and AI crawler policy.
metadata:
  version: "0.1.0"
---

# GEO — Generative Engine Optimization

AI answer engines (Google AI Overviews / AI Mode, ChatGPT search, Perplexity, Claude, Copilot) retrieve pages, extract passages, and cite sources. They favor pages that are **easy to quote**, **unambiguous about who/what/where**, **factually dense**, and **consistent across the web**. GEO is mostly excellent SEO plus a passage-level writing discipline. Apply this alongside `seo`, never instead of it.

## 1. Write answer-first passages

Every H2 that maps to a question gets a **direct answer in the first 1–2 sentences** (40–60 words), then supporting detail. The answer must stand alone when lifted out of the page — include the subject noun, not a pronoun.

Bad: "It usually takes a few hours and we handle everything."
Good: "A standard tank water heater installation in Boise takes 2–4 hours; Northside Plumbing removes the old unit, installs the new one, and hauls the old tank away the same visit."

Use this shape for: services, pricing, process, FAQs, comparisons, definitions, "best X for Y" lists.

## 2. Make entities unambiguous

- State the business name, category, and location in the first paragraph of Home and About, in plain words: "Northside Plumbing is a licensed residential plumbing company in Boise, Idaho, founded in 2014."
- Use the same name spelling everywhere (site, schema, social, directories). Entities that conflict do not get cited.
- `Organization`/`LocalBusiness`/`Person` schema with `sameAs` links to every official profile (LinkedIn, GBP, Instagram, Crunchbase, Wikipedia if any).
- An **About** page with founders, dates, credentials, and a short factual history; a **Contact** page with a real address.

## 3. Facts, numbers, specifics

AI engines prefer passages with concrete data: prices or ranges, timeframes, quantities, dates, named standards, locations. Replace vague claims with specifics ("over 1,400 installations since 2014", "licensed ID #PLB-12345", "serves 6 cities within 30 miles of Boise"). Where the user has no numbers, ask for them or mark clearly as samples to replace — never invent statistics that will ship.

## 4. Structure that extracts cleanly

- Question-form H2/H3s that match how people ask ("How much does a water heater cost in Boise?").
- Short paragraphs (≤ 3 sentences), real `<ul>/<ol>` lists for steps and options, `<table>` for comparisons and pricing tiers (tables are extracted very reliably).
- A visible **FAQ** section on every service/product page (5–8 questions) using `<details>`/`<summary>` or plain headings — plus `FAQPage` schema.
- A **TL;DR / Key facts** box near the top of long pages: 3–5 bullet facts.
- Definitions phrased as "X is …" when introducing a term.
- Dates: show `datePublished` and `dateModified` visibly; update content and the date when facts change — freshness is weighted.

## 5. Citation-worthiness

Pages get cited when they are the *source*, not a summary. Give each site at least one **original asset**: a pricing table, a local data point, a process checklist, a comparison, a glossary, a case study with numbers, an original photo set. Link out to authoritative sources for claims you did not originate (standards bodies, government, manufacturers) — being a good citer correlates with being cited.

## 6. `llms.txt` and crawler policy

Add `/llms.txt` (Markdown) at the site root summarizing the site for LLMs:

```markdown
# Northside Plumbing
> Licensed residential plumbing company in Boise, Idaho (est. 2014). Water heaters, repiping, drain cleaning, emergency service across Ada County.

## Key pages
- [Water heater installation](https://example.com/water-heater-installation): pricing ranges, timeline, brands installed
- [Emergency plumbing](https://example.com/emergency): 24/7 response times and coverage area
- [Pricing](https://example.com/pricing): flat-rate price table for common jobs
- [About](https://example.com/about): founders, licenses, service area

## Facts
- Phone: +1 208 555 0142 · Address: 412 N 8th St, Boise, ID 83702
- License: ID PLB-12345 · Hours: Mon–Fri 7–6, 24/7 emergency
```
Optionally `/llms-full.txt` with the full text of key pages. Link `llms.txt` from `robots.txt` via a comment and from the footer (small).

`robots.txt` AI crawlers — default **allow** (visibility is the goal); list explicitly so intent is clear:
```
User-agent: GPTBot
User-agent: OAI-SearchBot
User-agent: ClaudeBot
User-agent: Claude-SearchBot
User-agent: PerplexityBot
User-agent: Google-Extended
User-agent: Bingbot
Allow: /
```
If the user wants to block training but allow search citation, allow `OAI-SearchBot`/`Claude-SearchBot`/`PerplexityBot` and disallow `GPTBot`/`ClaudeBot`/`Google-Extended`. Explain the trade-off in one sentence and let the user choose.

## 7. Render server-side

AI crawlers execute little or no JavaScript. All content must be in the initial HTML: Astro static output or Next.js Server Components/SSG. No client-only rendering of copy, FAQs, or prices. Verify by fetching the raw HTML and checking the text is present.

## 8. Off-site consistency (advise the user)

Cited brands have consistent descriptions across GBP, LinkedIn, directories, and press. Provide the user a 25-word canonical description and a 60-word one to paste everywhere. Recommend 3–5 reputable listings/mentions relevant to their category (industry directories, local chambers, review platforms).

## 9. GEO audit

When auditing: fetch key pages, check for answer-first passages, entity clarity, specifics density, FAQ presence, tables/lists, visible dates, `llms.txt`, AI crawler policy, and SSR of content. Report as Critical / Important / Nice-to-have with rewrites of the top three passages as examples. Spawn `search-visibility-auditor` for multi-page work.

## Output

During builds: answer-first copy structure, FAQ blocks + schema, key-facts box, `llms.txt`, robots directives, canonical descriptions. During audits: the prioritized findings with passage rewrites.
