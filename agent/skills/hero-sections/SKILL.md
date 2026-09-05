---
name: hero-sections
description: >
  This skill should be used when designing or building the top of a web page — when the user
  asks for "a hero section", "above the fold", "the header area", "a better landing page top",
  "make the first screen hit harder", or when site-builder needs a hero pattern for the
  Design Brief. Provides 14 hero patterns with layout, copy structure, and code recipes.
metadata:
  version: "0.1.0"
---

# Hero Sections

The hero must answer three questions within two seconds: what is this, who is it for, what do I do next. Everything else is style. Pick a pattern from the library below that matches the archetype and differs from the previous site's hero (check `web-studio-log.md`). Code recipes for each pattern are in `references/patterns.md`.

## Non-negotiables

- One `<h1>` with the value proposition (specific, not clever): "Bookkeeping for restaurants that closes your month in 3 days" beats "Financial clarity, simplified".
- One primary CTA; at most one secondary (a text link or ghost button). Primary CTA text is a verb + outcome: "Book a free audit", "See the menu", "Start the trial".
- Proof element within the hero or immediately below: a stat, client logos, a star rating, a one-line testimonial, or "trusted by 1,200 clinics".
- Fits the first viewport on mobile (`min-height: 100svh` or less), with the CTA visible without scrolling on a 360×640 screen.
- Largest Contentful Paint element (headline or hero image) loads first: no lazy-loading on the hero image, preload it, no web-font blocking on the headline (use `font-display: swap` + metric fallback).
- Never a carousel. Never autoplay video with sound. Never a full-screen image with unreadable text on top without a scrim or solid panel.

## Pattern library

Pick by archetype; the number in brackets is the recipe in `references/patterns.md`.

1. **Type-only statement** [1] — headline at 8–12vw, short paragraph, one CTA, no image. Swiss, Brutalist, Japanese Minimal, Newspaper.
2. **Split 7/5** [2] — text left, visual right (or reversed). The default of many sites; make it distinctive with an unusual visual (masked image, tilted mock, illustration). Corporate, Organic, Scandinavian.
3. **Masthead** [3] — thin dateline/eyebrow strip, huge headline, one strong image below or beside, byline-style meta. Editorial, Newspaper.
4. **Full-bleed image + panel** [4] — background image with a solid or glass panel holding the copy, not text-over-image. Luxury, Cinematic, Real estate.
5. **Full-viewport word** [5] — one giant word/phrase fills the screen, tiny copy in a corner, scroll indicator. Cinematic, Brutalist.
6. **Marquee ticker** [6] — headline + a horizontally scrolling strip of services/clients/keywords. Brutalist, Retro-Futurist, Agencies.
7. **Bento** [7] — headline on top, a grid of 4–6 asymmetric tiles below (product shot, stat, testimonial, feature). Neo-Glass, SaaS.
8. **Product-first** [8] — the product image dominates; headline is small and low. Scandinavian, E-commerce.
9. **Terminal** [9] — typed headline with cursor, an install command as CTA, a code block. Terminal, Dev tools.
10. **Arched / masked image** [10] — image in an arch, blob, or circle mask beside soft copy. Organic, Wellness, Craft.
11. **Diagonal color split** [11] — two flat color fields on a diagonal, headline straddling. Bauhaus, Playful.
12. **Sticker collage** [12] — overlapping rotated images/stickers with a headline cutting through. Maximalist, Playful.
13. **Centered frame** [13] — perfectly symmetrical, ornamental frame lines, small centered CTA. Art Deco, Luxury.
14. **Scroll-pinned story** [14] — headline stays pinned while 3 images/lines swap as you scroll the first 200vh. Cinematic, Product launch.

## Copy structure

```
Eyebrow (optional, small, muted):   "For independent restaurants"
H1 (specific value):                 "Close your books in 3 days, not 3 weeks"
Subhead (how, 1–2 lines):            "Bookkeeping built around POS data, so month-end is done before the rent is due."
Primary CTA:                         "Book a free audit"
Secondary (text link):               "See how it works →"
Proof line:                          "★★★★★ 4.9 from 212 restaurant owners"
```

## Responsive rules

- Stack to single column below 768px; visual goes *below* copy unless it is the product (Product-first) or decorative (then hide or shrink).
- Headline `clamp()` with a hard `max-width` in `ch` (typically 12–18ch) so it wraps to 2–3 lines, never 5.
- Buttons full-width on mobile if there are two; side by side from 480px.
- Replace `100vh` with `100svh`; never force the hero taller than content + comfortable padding on mobile.

## Placeholder visuals in heroes

Use `placeholder-assets` to generate an SVG whose composition matches the pattern (portrait for Split, wide for Full-bleed, square for Arched). Add `data-replace="WIDTHxHEIGHT, subject, style notes"` and an honest `alt`.

## Output

State the pattern name and write the hero markup + styles using the site's tokens. Then continue with the rest of the page.
