---
name: animation
description: >
  This skill should be used when adding motion to a website — when the user asks for
  "animations", "make it feel alive", "scroll effects", "hover effects", "page transitions",
  "micro-interactions", "parallax", "a loading animation", "make it less static", or when
  site-builder needs a motion signature for the Design Brief. Covers CSS, scroll-driven
  animations, View Transitions, Framer Motion (Next.js) and GSAP, plus performance and
  reduced-motion rules.
metadata:
  version: "0.1.0"
---

# Animation

Motion should have one job per site: a **signature** (the thing people remember) plus quiet **micro-interactions** everywhere else. Too many effects read as amateur; one expressive move done well reads as a studio. Match intensity to the archetype: none/subtle (Swiss, Japanese, Docs, Newspaper), subtle (Editorial, Scandinavian, Corporate, Luxury-slow), expressive (Playful, Brutalist, Craft, Bauhaus), cinematic (Cinematic, Neo-Glass, Retro-Futurist).

**Use the verified recipes, do not improvise from memory.** `references/backgrounds.md` (aurora mesh, grain, dot-grid spotlight, canvas orbs, blob morph, parallax word, animated gradients, conic borders, marquee) and `references/interactive.md` (tilt + glare + glow border, magnetic button, line reveals, shimmer, staggered reveals, counters, cursor, transitions) contain code that was rendered and inspected. `examples/recipes.html` is the full working page — open it with Playwright and screenshot it to see the target look. Adapt colors and timing to the site's tokens; keep the structure.

**Motion must be seen before it ships.** After writing any animation, render the page with Playwright, wait 1.5s, move the pointer across interactive elements, screenshot, and look at the image with the Read tool. Then screenshot again with `emulateMedia({ reducedMotion: 'reduce' })` and confirm nothing is missing or stuck invisible. If the site has more than a signature effect, spawn the `motion-designer` agent, which does this loop for you.

## Why AI-generated animation looks bad (diagnose before fixing)

When motion "doesn't look good", it is almost always one of these. Check each against the code and the screenshot:

1. **Decor fights content** — a gradient blob or particle field crosses body text; muted text becomes unreadable. Fix: scrim under the text column, surfaces with their own semi-opaque ground + `backdrop-filter`, decor opacity ≤ 0.4 where it can touch text.
2. **Not enough blur** — "aurora" gradients rendered as hard-edged colored circles. Fix: `filter: blur(80–120px)`, blend mode, grain overlay to hide banding.
3. **Too fast** — background loops under 15s, reveals under 400ms, hover under 150ms. Ambient motion should be barely perceptible: 20–30s loops.
4. **Everything moves** — every card tilts, every heading shimmers, every section has particles. Fix: one signature effect per page, one background treatment per section at most, micro-interactions only on interactive elements.
5. **Default easing** — `ease` / `linear` on entrances. Fix: the easing tokens (`--ease-out`, `--ease-expo`, `--ease-spring`), ease-out for entrances, linear only for marquees and rotations.
6. **Synchronized loops** — several blobs sharing one duration so they pulse in lockstep. Fix: different durations (22/26/30s), `alternate`, random phase offsets.
7. **Wrong particle idea** — hundreds of tiny dots joined by lines (2016). Fix: few, large, very soft orbs; or a static dot grid with a cursor spotlight.
8. **No stagger or an endless one** — a grid pops in all at once, or item 12 appears 2s later. Fix: 40–80ms stagger capped at index 5–6.
9. **Layout animation** — animating `height`, `top`, `box-shadow`, `filter` on many elements → jank. Fix: `transform`/`opacity` only; glow via a pseudo-element's opacity.
10. **Colors off-palette** — neon defaults (#00ffff, #ff00ff) instead of the site's tokens. Fix: every color in motion comes from `--color-*`.
11. **Hover states that jump** — tilt or magnetic effects without a transition on `pointerleave`, or `transform` set while a CSS transition is also running on the same property. Fix: one owner per property; transition on the element; reset to `''` on leave.
12. **Missing reduced-motion and touch handling** — pointer effects firing on touch, animations that leave content invisible when disabled. Fix: gate with `prefers-reduced-motion` and `pointerType === 'mouse'`; reveals default to visible without JS.
13. **Ships untested** — never rendered. Fix: the Playwright screenshot loop above. This is the actual root cause of most of the rest.

## Rules that always apply

1. **Respect `prefers-reduced-motion`**: wrap all non-essential motion, disable parallax/marquee/auto-play, keep opacity fades ≤ 200ms.
   ```css
   @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; scroll-behavior: auto !important; } }
   ```
2. **Animate only `transform`, `opacity`, `clip-path`, `filter`** (compositor-friendly). Never animate `width/height/top/left/margin/box-shadow` on scroll; for shadow hover use a pseudo-element with opacity.
3. **Durations**: micro 120–200ms, UI state 200–300ms, reveals 400–700ms, cinematic 800–1400ms. Nothing over 1.5s except ambient loops.
4. **Easings as tokens**:
   ```css
   :root { --ease-out: cubic-bezier(.22,1,.36,1); --ease-in-out: cubic-bezier(.65,0,.35,1); --ease-spring: cubic-bezier(.34,1.56,.64,1); --ease-expo: cubic-bezier(.16,1,.3,1); }
   ```
   Entrances ease-out; exits ease-in; playful things spring; luxury things expo with long durations.
5. **Entrances happen once**. Reveal-on-scroll elements start visible for users without JS (`.js .reveal { opacity: 0 }` only after a `js` class is added to `<html>`).
6. Never block content: no full-screen preloaders over 800ms, no scroll-jacking, no cursor replacement that hides the real cursor on touch devices.
7. Stagger children by 40–80ms, cap total stagger at ~500ms.

## Core recipes (vanilla, work in Astro and static)

**Reveal on scroll** (IntersectionObserver, once):
```css
.js .reveal { opacity: 0; transform: translateY(18px); transition: opacity .6s var(--ease-out), transform .6s var(--ease-out); transition-delay: var(--d, 0ms); }
.js .reveal.in { opacity: 1; transform: none; }
```
```js
document.documentElement.classList.add('js');
const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -10% 0px' });
document.querySelectorAll('.reveal').forEach((el, i) => { el.style.setProperty('--d', `${(i % 6) * 60}ms`); io.observe(el); });
```

**Line-by-line headline reveal** (Editorial/Cinematic): split by `<span class="line"><span>` and animate inner span `translateY(110%) → 0` with `overflow: hidden` on the outer; stagger 60ms.

**Scroll-driven (CSS, no JS)**: progress bar, parallax, fade-as-you-scroll:
```css
@supports (animation-timeline: scroll()) {
  .progress { animation: grow linear both; animation-timeline: scroll(root); transform-origin: left; }
  @keyframes grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
  .parallax { animation: drift linear both; animation-timeline: view(); }
  @keyframes drift { from { transform: translateY(6%); } to { transform: translateY(-6%); } }
}
```

**Hover micro-interactions**: link underline grows from left (`background-size` 0→100%); button arrow nudges 4px; card image `scale(1.03)` over 500ms with `overflow: hidden`; nav items get a sliding indicator (`view-transition-name` or a moved pseudo-element).

**Marquee**, **typewriter**, **blink**: see `hero-sections/references/patterns.md`.

**Number counters** for stats: count up over 1.2s when visible; use `requestAnimationFrame`, format with `Intl.NumberFormat`, show final value immediately for reduced motion.

**Ambient**: slow gradient-mesh drift (`background-position` over 20s, or transform on absolutely positioned blurred blobs), floating decorative shapes (`translateY` ±8px over 6s). Ambient loops must be `will-change: transform`, few, and paused when off-screen (`animation-play-state` via IntersectionObserver).

## Page transitions

- **Astro**: `import { ClientRouter } from 'astro:transitions'` in the base layout; give the persistent header `transition:persist`; give hero images `transition:name="hero"` across pages for morphing. Default fade is fine; use `slide` for editorial.
- **Next.js**: View Transitions API via `document.startViewTransition` in a small client component wrapping `router.push`, or Framer Motion `AnimatePresence` in `template.tsx`.
- **Static**: `@view-transition { navigation: auto; }` in CSS for same-origin MPA transitions (progressively enhanced).

## Library guidance

- **CSS only** covers 80% of sites. Prefer it.
- **GSAP + ScrollTrigger** for pinned/scrubbed cinematic sequences (Cinematic, Product launch). Load from cdnjs, register plugin, always `gsap.matchMedia()` with a reduced-motion branch, and `ScrollTrigger.refresh()` after fonts load.
- **Framer Motion** (`motion/react`) in Next.js for component-level animation: `whileInView`, `layout`, `AnimatePresence`. Keep it in leaf `"use client"` components.
- **Lottie** only if the user supplies a Lottie file. Do not fabricate one.
- **Three.js / WebGL**: only when explicitly asked; otherwise fake 3D with CSS gradients, `perspective` tilt, and SVG.

## Signature moves by archetype (pick one, write it into the Design Brief)

Swiss: none — the restraint is the signature. Brutalist: marquee + instant black/white hover inversion. Editorial: line-by-line text reveals + image fade-scale. Luxury: 1000ms fades, 0.2 parallax, cursor-following highlight. Playful: spring bounces on scroll-in, wiggling stickers. Corporate: counters + subtle reveals. Terminal: typewriter + blinking cursor. Organic: floating blobs, slow eases. Retro-Futurist: glow pulses, rotating starburst, chrome shimmer (animated gradient). Bauhaus: shapes slide/rotate into place on load. Japanese: single slow fade. Maximalist: multi-speed parallax layers. Art Deco: SVG line-draw (`stroke-dashoffset`). Neo-Glass: mesh drift + 3D tilt on hover (`perspective` + pointer position). Craft: badge wobble. Scandinavian: image crossfade on hover. Cinematic: pinned scroll scenes with mask reveals. Neumorphic: press-in states. Newspaper: none. Docs: none.

## Performance checklist

`will-change` only on elements actually animating and remove after; no layout thrash in scroll handlers (read then write, `passive: true`); IntersectionObserver over scroll listeners; total JS for animation < 30KB gzipped unless GSAP is justified; test at 4× CPU throttle; verify no CLS from entrance animations (reserve space, animate transform not height).

## If the home page moves, the portal's thumbnail has to move with it

The operator's client grid draws each site from a screenshot taken at deploy
time (`/__preview/home-tile.png`). For almost every site that is the right
picture. For a site whose **home page above the fold** animates — an aurora or
mesh background, a canvas field, a marquee, a hero that assembles on load — it
is not: the shot catches one arbitrary frame, and it is taken under
`reducedMotion: 'reduce'`, so a background whose whole character is motion can
photograph as a flat block of colour. The tile then misrepresents the site to
the only person who checks all of them.

Such a site should be drawn as a live frame instead. That needs two things,
and **both are your job in the same pull request that ships the animation**:

1. **The site must let the portal frame it.** Repositories scaffolded from our
   template already do — `netlify.toml` ships
   `Content-Security-Policy: frame-ancestors 'self' https://portal.mortensenweb.com`.
   Check that it is there. An older site usually sends a blanket
   `X-Frame-Options: DENY`/`SAMEORIGIN` or `frame-ancestors 'none'` instead,
   which refuses the portal and renders an empty tile. Replace it with the
   line above — drop `X-Frame-Options` entirely, as it has no allowlist form
   and cannot express this.

   `netlify.toml` is in the merge guard, so a pull request touching it will
   not auto-merge and waits for a person. That is expected. **Say in the pull
   request body that the header change is there and why**, so the wait is one
   glance rather than an investigation.

2. **The site has to be switched over in the portal.** You cannot do this from
   the repository — it is a column on the site. Say so explicitly in the pull
   request body: *"This home page is animated. Set Grid thumbnail →
   Live page on this site in the portal (client → the site → Grid
   thumbnail), or the tile will keep showing a still frame."*

If the animation is below the fold, or the home page is static and only inner
pages move, change nothing: the screenshot is still an honest likeness, and a
live frame costs a whole page load per tile for no gain.

## Output

Emit the easing tokens, the reduced-motion block, the reveal system, the chosen signature move, and page transitions for the stack. Keep the animation code in one file (`animations.js` / `motion.ts`) so it is easy to tune.
