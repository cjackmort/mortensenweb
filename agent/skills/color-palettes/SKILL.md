---
name: color-palettes
description: >
  This skill should be used when choosing or checking colors for a website — when the user asks
  for "a color palette", "colors that work together", "pick brand colors", "fix my contrast",
  "make a dark mode", "generate color tokens", or when site-builder needs the palette for a
  Design Brief. Produces harmonious, accessible, token-ready palettes with light/dark variants.
metadata:
  version: "0.1.0"
---

# Color Palettes

Build a palette that (1) matches the design archetype and mood, (2) passes WCAG AA for every text/background pair actually used, (3) ships as CSS tokens with a dark variant. Work in OKLCH mentally (lightness, chroma, hue) even when outputting hex — it keeps perceived lightness consistent.

## Step 1 — Choose a harmony from the mood

| Mood | Harmony | How |
|---|---|---|
| calm, premium, editorial | **Monochrome + one accent** | one hue at 5 lightness steps + a complementary accent at low usage |
| trustworthy, corporate | **Analogous** | three hues within 30–60° (e.g. teal → blue → indigo) + warm neutral |
| bold, energetic | **Complementary** | two hues ~180° apart, one dominant, one at ≤10% area |
| playful, friendly | **Triadic / tetradic** | 3–4 hues equally spaced, equal chroma, on a warm white |
| natural, grounded | **Earth analogous** | desaturated hues in 30–120° (ochre, olive, clay, moss) |
| luxury | **Dark neutral + metallic** | near-black warm neutral, one warm metallic accent |
| technical | **Dark neutral + one signal color** | cool grays + one saturated cue color for links/active |

Rule: chroma is the loudest signal. High chroma on large areas = playful/loud. Low chroma = calm/premium. Pick chroma before hue.

## Step 2 — The 60 / 30 / 10 allocation

- **60% Ground** — page background(s). Never pure #FFFFFF unless Swiss/Scandinavian; tint it toward the brand hue by 2–4% (e.g. #FAF9F6 warm, #F5F7FA cool).
- **30% Surface + text** — cards, sections, headings. Text is never pure black; use a hue-tinted near-black (#1B1A17 warm, #0F1419 cool).
- **10% Accent** — buttons, links, highlights. One accent, maybe a second "support" accent for success/notice.

## Step 3 — Generate the token set

Produce exactly this shape, both themes:

```css
:root {
  --color-bg: #F6F1E7;        /* ground */
  --color-bg-alt: #EFE8DA;    /* alternating band */
  --color-surface: #FFFFFF;   /* cards, inputs */
  --color-border: #D9D2C3;
  --color-text: #1B1A17;
  --color-text-muted: #5C5750;
  --color-primary: #8C2F1B;   /* main CTA */
  --color-primary-hover: #742514;
  --color-on-primary: #FFFFFF;
  --color-accent: #2E5E4E;    /* links, highlights */
  --color-success: #2E7D32;
  --color-warning: #B26A00;
  --color-danger:  #B3261E;
  --color-focus:   #2E5E4E;   /* focus ring, must contrast with bg AND surface */
}
:root[data-theme="dark"] { /* lightness flipped, chroma reduced ~15%, same hues */ }
```

Dark mode rules: do not invert. Lower chroma of accents by ~10–20% so they don't vibrate, lift the ground to a tinted near-black (#111312 warm, #0B1017 cool), use elevated surfaces slightly lighter than ground (not shadows), and reduce pure-white text to ~#E8E6E1.

## Step 4 — Contrast verification (mandatory)

Check every pair that actually appears: text/bg, text/surface, text-muted/bg, on-primary/primary, accent/bg (links), focus/bg, focus/surface. Targets: body text ≥ 4.5:1, large text (≥24px or ≥19px bold) ≥ 3:1, UI borders/icons ≥ 3:1. Run the check programmatically rather than guessing:

```js
// relative luminance + contrast ratio (WCAG 2.x)
const lum = h => { const [r,g,b] = h.match(/\w\w/g).map(x=>parseInt(x,16)/255).map(c=>c<=.03928?c/12.92:((c+.055)/1.055)**2.4); return .2126*r+.7152*g+.0722*b; };
const ratio = (a,b) => { const [x,y]=[lum(a),lum(b)].sort((p,q)=>q-p); return ((x+.05)/(y+.05)).toFixed(2); };
```

If a pair fails, adjust **lightness only** (keep hue and chroma) until it passes. Report the ratios in the Design Brief.

## Step 5 — Usage rules to write into the brief

- Accent appears on: primary buttons, active nav, links, one decorative element. Nowhere else.
- Never put saturated accent text on saturated accent background.
- Gradients only if the archetype calls for them (Neo-Glass, Retro-Futurist, Playful). If used, keep both stops within 60° of hue and similar lightness.
- Section alternation: ground → bg-alt → ground, or ground → dark inverted band → ground. Not random.

## Ready-made starting palettes (adjust lightness for contrast)

- **Ink & Cream** (editorial): #F6F1E7 / #1B1A17 / #8C2F1B / #2E5E4E
- **Slate & Ember** (corporate warm): #F4F5F7 / #10233F / #F25C2E / #0E9F9F
- **Sand & Sage** (organic): #EFE6D8 / #2F2A26 / #4F6B4A / #C67B5C
- **Noir & Gold** (luxury): #0B0B0C / #D6D2CB / #C8A96A / #7A6B4F
- **Acid Brut** (brutalist): #FFFFFF / #000000 / #CCFF00 / #FF5E00
- **Sorbet** (playful): #FFF8F0 / #2B2B2B / #FF6B6B / #06D6A0 / #FFD166 / #118AB2
- **Phosphor** (terminal): #0D1117 / #C9D1D9 / #3FB950 / #FFB000
- **Aurora** (neo-glass): #070A14 / #F1F3FF / #1DE9B6 / #7C4DFF / #FF3CAC
- **Deco** (art deco): #0E0E0E / #F2E9D8 / #D4AF37 / #0B6E4F
- **Kraft** (craft): #D9C4A9 / #2B1D14 / #D64933 / #3E5C76
- **Primary Block** (bauhaus): #FFFFFF / #111111 / #D62828 / #FCBF49 / #003F91
- **Washi** (japanese minimal): #FAFAF8 / #1C1C1C / #C73E1D
- **Newsprint** (broadsheet): #F3F1EC / #121212 / #B3261E

Never reuse the same family as the previous site in the studio log.

## Output

Return the token block (light + dark), the contrast table, and the usage rules. Nothing else unless asked.
