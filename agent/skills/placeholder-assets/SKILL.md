---
name: placeholder-assets
description: >
  This skill should be used when a website needs images, icons, logos, or media that the user
  has not supplied — when the user says "I don't have photos yet", "use placeholders",
  "generate placeholder images", "make a temporary logo", "we need an OG image", "add icons",
  or when site-builder builds any section with imagery. Generates self-contained SVG/CSS art
  styled to the site's palette, plus a replacement spec so real assets can be dropped in later.
metadata:
  version: "0.1.0"
---

# Placeholder Assets

Never leave a gray box that says "IMAGE". Never hotlink stock photos unless the user asked for them. Generate **on-brand, self-contained SVG art** that (a) looks intentional in the design, (b) carries the correct aspect ratio so swapping in a real photo will not shift layout, and (c) documents exactly what the real asset should be.

## The replacement contract

Every placeholder gets:
- `alt` describing the intended real image ("Founder Maya Chen in the workshop, warm window light") — not "placeholder".
- `data-replace="WIDTHxHEIGHT, subject, style notes"` on the `<img>`/`<figure>`.
- An entry in `ASSETS-TO-REPLACE.md` (path/component, dimensions, aspect ratio, subject, style, priority).
- `width` and `height` attributes (or `aspect-ratio` CSS) so there is zero CLS on swap.

## Styles (pick one per site, matching the archetype)

1. **Gradient mesh** — 3–4 blurred radial gradients in palette hues on the ground color; optional grain. Neo-Glass, Corporate, Luxury.
2. **Duotone field** — a subtle geometric or organic pattern rendered in text + accent colors. Editorial, Newspaper.
3. **Geometric composition** — circles, bars, triangles in flat palette colors on a grid. Bauhaus, Swiss, Playful.
4. **Organic blobs** — 2–3 overlapping soft shapes with slight transparency. Organic, Craft, Wellness.
5. **Line art** — thin stroke illustration of the subject's category (a mug, a house, a leaf) on plain ground. Japanese, Scandinavian, Craft.
6. **Halftone / grain** — dotted screen pattern with a big shape. Brutalist, Maximalist, Newspaper.
7. **Chrome / glow** — radial highlight spheres and a horizon grid. Retro-Futurist.
8. **Labeled frame** — honest frame with dimension text and subject label in mono (`1600×900 · Team photo`). Terminal, Docs, or when the user prefers obvious placeholders.
9. **Photo-like tone field** — a warm/cool vignette that reads as "there will be a photo here" without shapes. Cinematic, Luxury.

## Generator script

`scripts/placeholder.mjs` produces SVG files from a style + palette + size + label. Node, no dependencies.

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/placeholder-assets/scripts/placeholder.mjs \
  --style mesh --w 1600 --h 900 --colors "#F6F1E7,#8C2F1B,#2E5E4E" --label "Hero image" --seed 7 --out public/img/hero.svg
```
Styles: `mesh | duotone | geometric | blobs | lineart | halftone | chrome | frame | tone`. `--seed` makes results reproducible; change it for variety within one site. `--grain` adds an SVG noise overlay. `--text` puts a big word in the art (useful for OG images). Run it once per asset; keep files in `public/img/` (Astro/Next) or inline the SVG for heroes (LCP benefits from inline).

If Node is unavailable, hand-write the SVG using the same recipes (each style is ~20 lines).

## Logos and favicons

When no logo exists, produce a **temporary wordmark**: the business name set in the display font as an SVG (`<text>` converted to outlines is not possible without tooling — use `<text>` with the web font and a `font-family` fallback, and note it in ASSETS-TO-REPLACE). Add a simple **mark**: a geometric monogram (first letter in a shape) in the primary color. Export: `favicon.svg`, `favicon-32.png`/`apple-touch-icon.png` when a rasterizer (sharp/rsvg-convert/Playwright screenshot) is available; otherwise ship SVG + note.

## OG / social image

1200×630 SVG with: ground color, the site's placeholder style at low intensity, the wordmark, and the page title in the display font. Rasterize to PNG for `og:image` when possible (Playwright: open the SVG in a page and screenshot at 1200×630). Next.js: use `app/opengraph-image.tsx` and skip the file.

## Icons

Do not draw a bespoke icon set. Use inline SVG from an open set — Lucide (MIT) or Tabler (MIT) — pasted as `<svg>` with `aria-hidden="true"` and `stroke="currentColor"` so they take the text color. Pick one set per site and one stroke width (1.5 or 2). Only use icons if the archetype calls for them (Corporate, Playful, Docs); Editorial/Swiss/Luxury sites usually look better with numerals or none.

## Video and maps

Video: a poster-style placeholder (style 9 + a play glyph), `data-replace="1920x1080 mp4, 15s loop, no audio"`. Maps: a stylized SVG "map" (grid of streets in muted color + a pin in accent) with the address as text and a link to Google Maps directions; embed the real map only when the user asks (privacy + weight).

## Real free imagery (only when the user opts in)

If the user chooses stock photos: Unsplash Source is deprecated — use `https://picsum.photos/seed/{seed}/{w}/{h}` for generic photos or ask the user for specific Unsplash/Pexels URLs. Always still add `data-replace`, since stock rarely matches the brand.

## Output

Write the assets, reference them in the components with the replacement contract, and produce `ASSETS-TO-REPLACE.md` ordered by priority (hero first).
