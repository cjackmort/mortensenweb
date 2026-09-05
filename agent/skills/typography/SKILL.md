---
name: typography
description: >
  This skill should be used when choosing or setting fonts for a website — when the user asks
  "what fonts should I use", "pick a font pairing", "set up the type scale", "the text looks
  off", "make the headings more distinctive", or when site-builder needs a type pairing for
  a Design Brief. Covers pairings, fluid scale, loading, and readability rules.
metadata:
  version: "0.1.0"
---

# Typography

Type carries more of a site's personality than color does. Choose a pairing that matches the archetype, set a fluid scale, load fonts without layout shift, and enforce readability.

## Step 1 — Pick a pairing by archetype

Pairing formula: **one voice, one workhorse, optionally one utility**. Voice = display/headlines (can be expressive). Workhorse = body (must be quiet and legible). Utility = mono or small-caps sans for labels, eyebrows, meta.

| Archetype | Voice (display) | Workhorse (body) | Utility |
|---|---|---|---|
| Swiss | Inter Tight / Archivo / Schibsted Grotesk | same family | same, uppercase tracked |
| Brutalist | Archivo Black / Anton | system-ui or Archivo | ui-monospace |
| Editorial | Fraunces / Playfair Display / Instrument Serif | Source Serif 4 / Newsreader | JetBrains Mono |
| Luxury Dark | Cormorant Garamond / Bodoni Moda | Jost 300 / Montserrat 300 | Jost small caps |
| Playful Pop | Fredoka / Baloo 2 / Sora 800 | Nunito / DM Sans | — |
| Corporate Clean | Source Sans 3 600 / Public Sans | IBM Plex Sans | IBM Plex Mono |
| Terminal | JetBrains Mono / IBM Plex Mono | same | same |
| Organic | Lora / Literata / Gambetta | Figtree / Karla | — |
| Retro-Futurist | Syne / Unbounded / Michroma | Space Grotesk | Space Mono |
| Bauhaus | Jost 700 / Outfit / League Spartan | Jost 400 | — |
| Japanese Minimal | Shippori Mincho / Zen Old Mincho | Manrope 300 / Noto Sans | — |
| Maximalist | DM Serif Display + Caveat | Archivo | Special Elite |
| Art Deco | Poiret One / Limelight / Marcellus | Josefin Sans | Josefin Sans caps |
| Neo-Glass | Geist / Plus Jakarta Sans / Manrope | same | Geist Mono |
| Warm Craft | Fraunces (soft) / Bricolage Grotesque | Nunito Sans | Caveat (handwritten labels) |
| Scandinavian | Familjen Grotesk / Inter Tight | same | — |
| Cinematic | Bebas Neue / Oswald / Anton | Inter / Roboto | — |
| Neumorphic | Nunito / Quicksand | same | — |
| Newspaper | Playfair Display SC / Old Standard TT / Libre Caslon | Libre Franklin | Libre Franklin caps |
| Dark Docs | Inter / Geist | same | Fira Code / Geist Mono |

Never pair two expressive faces as voice + workhorse (except Maximalist, deliberately). Never use the same pairing as the previous site in the studio log.

## Step 2 — Fluid type scale

Use `clamp()` so type scales with viewport without breakpoints. Ratio: 1.2 (minor third) for dense/corporate, 1.25–1.333 for editorial, 1.5+ for brutalist/cinematic where headlines should be enormous.

```css
:root {
  --font-display: "Fraunces", Georgia, serif;
  --font-body: "Source Serif 4", Georgia, serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;

  --text-xs:  clamp(0.75rem, 0.72rem + 0.15vw, 0.8rem);
  --text-sm:  clamp(0.875rem, 0.84rem + 0.2vw, 0.95rem);
  --text-base:clamp(1rem, 0.95rem + 0.3vw, 1.125rem);
  --text-lg:  clamp(1.125rem, 1.05rem + 0.4vw, 1.35rem);
  --text-xl:  clamp(1.35rem, 1.2rem + 0.8vw, 1.8rem);
  --text-2xl: clamp(1.8rem, 1.4rem + 1.8vw, 2.6rem);
  --text-3xl: clamp(2.4rem, 1.6rem + 3.5vw, 4rem);
  --text-4xl: clamp(3rem, 1.5rem + 6.5vw, 6.5rem);   /* hero */
  --leading-tight: 1.05; --leading-snug: 1.2; --leading-body: 1.6;
  --tracking-tight: -0.02em; --tracking-wide: 0.08em;
}
```

Headlines: tight leading (1.0–1.1) and slightly negative tracking for sans; serifs usually want 0 tracking. Body: 1.5–1.7 leading, measure 55–75 characters (`max-width: 65ch`). Labels/eyebrows: uppercase, `letter-spacing: 0.08–0.14em`, small size, muted color.

## Step 3 — Load fonts without layout shift

**Astro / static**: Google Fonts with `display=swap`, preconnect, and only the weights used:
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,600&family=Source+Serif+4:wght@400;600&display=swap" rel="stylesheet">
```
Add `size-adjust`/metric fallbacks via `@font-face { font-family: "Fallback"; src: local("Georgia"); size-adjust: 104%; }` when CLS matters (Astro: use `astro:assets` fonts or the `fontaine`-style approach).

**Next.js**: `next/font/google` — self-hosted automatically, zero CLS:
```ts
import { Fraunces, Source_Serif_4 } from "next/font/google";
const display = Fraunces({ subsets: ["latin"], axes: ["opsz"], variable: "--font-display" });
```

Variable fonts over multiple static weights. Max 2 families + 1 mono; max ~4 weight/style combos total.

## Step 4 — Readability rules

- Body ≥ 16px on mobile, ≥ 17–18px on desktop for editorial/long-form.
- Paragraph spacing = 1em, not double line breaks.
- Never justify text on the web. Never center more than 3 lines.
- `text-wrap: balance` on headings, `text-wrap: pretty` on paragraphs.
- Prevent orphans in hero headlines by controlling line breaks with `<br>` or `max-width` in `ch`.
- OpenType: enable `font-feature-settings: "ss01", "cv11"` etc. only when the archetype benefits; enable `"tnum"` for tables and stats.
- Contrast for text-muted still ≥ 4.5:1.

## Step 5 — Distinctive type moves (choose one per site)

Oversized numerals for stats or section numbers; a hero headline set at `--text-4xl` with mixed italic; eyebrow labels in mono with brackets; drop caps (`::first-letter`); vertical labels (`writing-mode: vertical-rl`); outlined text (`-webkit-text-stroke`) for one word; a marquee wordmark; hanging punctuation; ultra-wide tracking on all-caps subheads; a variable-font weight animation on hover. Write the move into the Design Brief.

## Output

Return the font declarations, the scale tokens, the load snippet for the chosen stack, and the one distinctive move.
