---
name: layout-and-buttons
description: >
  This skill should be used when structuring pages or building UI controls — when the user asks
  about "page layout", "section structure", "spacing", "the grid", "buttons", "button styles",
  "navigation", "the footer", "cards", "the site feels cramped/empty", or when site-builder
  needs the layout grammar for a Design Brief. Covers grid, spacing scale, section rhythm,
  nav, footer, and a complete button system.
metadata:
  version: "0.1.0"
---

# Layout and Buttons

Layout is rhythm: a spacing scale, a grid, and a repeating section cadence. Buttons are the site's hands: they must be obvious, consistent, and match the archetype. Define both as tokens before writing components.

## Spacing scale

Use a single scale everywhere; never invent a value.

```css
:root {
  --space-1: .25rem; --space-2: .5rem; --space-3: .75rem; --space-4: 1rem; --space-5: 1.5rem;
  --space-6: 2.5rem; --space-7: 4rem; --space-8: 6rem; --space-9: 9rem;
  --section-y: clamp(var(--space-7), 10vw, var(--space-9));   /* vertical padding of sections */
  --container: 72rem;             /* 1152px; 80–90rem for wide archetypes */
  --gutter: clamp(1rem, 4vw, 2.5rem);
  --radius-sm: 4px; --radius-md: 8px; --radius-lg: 16px; --radius-xl: 28px; --radius-pill: 999px;
}
.container { width: min(100% - 2*var(--gutter), var(--container)); margin-inline: auto; }
.section { padding-block: var(--section-y); }
```

Per archetype, change **three** things: `--section-y` (dense archetypes ~4rem, airy ones 9rem+), `--container` (Japanese/Luxury narrower ~60rem; Cinematic/Brutalist full-bleed), and the radius family (Swiss/Brutalist/Editorial: 0; Corporate: md; Organic/Playful: xl or pill).

## Grid

12-column CSS grid for page-level composition; `auto-fit` grids for repeated items.

```css
.grid-12 { display: grid; grid-template-columns: repeat(12, 1fr); gap: var(--gutter); }
.auto-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr)); gap: var(--space-5); }
```

Asymmetry is the cheapest way to look designed: a 5/7 split, a text block starting at column 2, an image that bleeds past the container (`margin-inline: calc(-1 * var(--gutter))`), or an intentionally empty column. Use at least one asymmetric section per page (except Art Deco / Centered Frame archetypes, which are symmetrical by definition).

## Section cadence

A page is a sequence of sections with alternating **weight**. Never place two "heavy" (dark band, full-bleed image) or two "light" text sections back to back. Typical marketing page order:

1. Hero (heavy)
2. Proof strip: logos / stats / rating (light, short)
3. Problem → promise (light text, asymmetric)
4. Features / services (medium; grid or alternating rows — never three identical icon cards unless Corporate)
5. Showcase: image-led, full-bleed or bento (heavy)
6. Process or "how it works" (light; numbered, big numerals)
7. Testimonials (medium; one big quote beats a carousel)
8. Pricing or offer (medium)
9. FAQ (light; `<details>` accordion — good for GEO)
10. Final CTA band (heavy; restate the H1 promise)
11. Footer

Dividers between sections: pick one and stick to it — hairline rule, color-band change, angled edge (`clip-path: polygon`), wave (SVG), or none (whitespace only).

## Navigation

- Desktop: logo left, 4–6 links, one CTA button right. Sticky only if the page is long; when sticky, shrink on scroll and add a subtle border, not a shadow.
- Mobile: hamburger opens a full-screen panel with large links (min 48px tap targets), the CTA, and contact info. Use a `<dialog>` or `<nav aria-expanded>` with focus trapping; close on Escape.
- Current page indicated (`aria-current="page"`) with an underline or weight change, not color alone.
- Skip link as the first focusable element: `<a class="skip" href="#main">Skip to content</a>`.
- Archetype variants: side rail nav (Editorial/Docs), top marquee nav (Brutalist), centered logo with links split either side (Art Deco/Luxury), vertical text nav (Japanese).

## Footer

Big footers convert. Include: wordmark (large — a giant footer wordmark is a strong signature), nav columns, contact (address, phone as `tel:`, email), hours if local, social links, newsletter form if relevant, legal links, copyright with current year, and for local businesses the NAP (Name, Address, Phone) exactly matching Google Business Profile. Style it as the inverse of the page (dark on a light site) unless the archetype forbids.

## Cards

Cards are not mandatory. Alternatives: rows with rules, a numbered list, a bento grid, a table, a marquee, tabs. When using cards: consistent padding (`--space-5`), a real border **or** a background tint **or** a shadow — never all three; radius from the token family; hover lifts ≤ 4px or changes border color; the whole card is the link (`<a>` wrapping or a pseudo-element stretch).

## Button system

Define once as tokens + classes; use everywhere. Three roles: **primary** (one per view), **secondary**, **ghost/text**. Two sizes: default (44–48px tall) and small (36px, never for primary CTAs). Icon buttons need `aria-label`.

```css
.btn { display: inline-flex; align-items: center; gap: .5em; min-height: 3rem; padding: 0 1.5rem;
  font: 600 var(--text-base)/1 var(--font-body); border-radius: var(--btn-radius, var(--radius-md));
  border: 2px solid transparent; cursor: pointer; text-decoration: none; white-space: nowrap;
  transition: background .18s var(--ease-out), color .18s, border-color .18s, transform .18s, box-shadow .18s; }
.btn-primary { background: var(--color-primary); color: var(--color-on-primary); }
.btn-primary:hover { background: var(--color-primary-hover); }
.btn-secondary { border-color: currentColor; color: var(--color-text); background: transparent; }
.btn-secondary:hover { background: var(--color-text); color: var(--color-bg); }
.btn-ghost { padding-inline: .5rem; background: none; color: var(--color-accent); text-decoration: underline; text-underline-offset: .25em; }
.btn:focus-visible { outline: 3px solid var(--color-focus); outline-offset: 3px; }
.btn:active { transform: translateY(1px); }
.btn[aria-disabled="true"], .btn:disabled { opacity: .5; pointer-events: none; }
.btn-sm { min-height: 2.25rem; padding-inline: 1rem; font-size: var(--text-sm); }
```

Archetype button personalities (set `--btn-radius` and override hover):
- **Swiss / Scandinavian**: 0 radius, black fill, uppercase tracked label.
- **Brutalist**: 0 radius, 3px black border, `box-shadow: 4px 4px 0 #000`; on hover translate(2px,2px) and shrink shadow.
- **Editorial / Newspaper**: text link with underline that thickens on hover; a single thin-bordered rectangle for the main CTA.
- **Luxury / Art Deco**: 1px accent outline, uppercase, wide tracking, fill on hover with 400ms ease.
- **Playful / Craft**: pill, thick, second-color hard shadow, `scale(1.04)` on hover with a spring ease.
- **Organic / Neumorphic**: pill, low contrast, soft shadow; neumorphic uses double shadow and insets on active.
- **Terminal / Docs**: small, mono, bordered box, `>` prefix, inverts on hover.
- **Neo-Glass**: glass background, 1px white/20 border, gradient primary with outer glow on hover.
- **Cinematic**: text + arrow that slides right; or a 56px circle with an arrow.

Never use gradient buttons outside Neo-Glass/Retro-Futurist. Never use a dropshadow and a border and a gradient together. Never use "Submit" or "Click here" as a label.

## Forms

Inputs 48px tall, 16px font (prevents iOS zoom), visible labels (no placeholder-only), `autocomplete` attributes, inline validation on blur, one column, the submit button styled `.btn-primary` full-width on mobile. Contact forms on Netlify: add `data-netlify="true"` and a honeypot field.

## Output

Emit the tokens, `.container/.section/.grid` utilities, nav, footer, and button classes for the chosen archetype; then build sections in the cadence above.
