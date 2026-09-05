# mortensenweb.com

The public agency site. Astro, static output, no client-side framework.

```bash
npm run dev --workspace apps/portfolio      # http://localhost:4321
npm run build --workspace apps/portfolio    # dist/
npm run check --workspace apps/portfolio    # astro check (types + templates)
```

## Where things are

| | |
| --- | --- |
| Pages | `src/pages/*.astro`, plus `robots.txt.ts` and `llms.txt.ts` |
| Layout | `src/layouts/Base.astro` — head, fonts, header, footer, JSON-LD, the one inline script |
| Design system | `src/styles/global.css` — tokens, type, the pinned story, every component |
| Copy that repeats | `src/data/site.ts` (the four steps, the marquee, contact details) |
| Work | `src/data/work.ts` + `public/work/*.webp` (1120×700 and a `-640` variant) |
| Plans | `@mortensenweb/plans` (`packages/plans`) — shared with the portal's seed |

## Decisions worth knowing

**Zero JavaScript by design.** The previous site shipped 457 KB of framework to render five pages and hid every section until it had run. Motion here is CSS: headline lines rise with keyframes, sections reveal with `animation-timeline: view()` inside `@supports`, and the pinned story runs on a named view timeline. Browsers without those features, and readers who prefer reduced motion, see everything at rest. The only script is a few hundred bytes for the hero spotlight and magnetic buttons, mouse-only, and the analytics tag.

**Design direction: Swiss / International** with a monospace label system. One grotesk (Schibsted Grotesk), one mono (JetBrains Mono), one blue — the portal's, so a client who reads this site and then signs in sees the same colour meaning the same thing. Hairline rules instead of cards. Asymmetry on a strict grid.

**Prices come from `packages/plans`.** Do not type a price into a page. Change the package and the portal seed and this site change together.

**The contact form is Netlify Forms.** It must exist in the built HTML (`data-netlify`, hidden `form-name`, honeypot, `action="/thanks/"`). Netlify detects it at build time.

**Verification.** `node ../../agent/verify/check.mjs dist` runs the same structural checks the client-site pipeline runs: every link and image resolves, alt text, no external images, a title per page.
