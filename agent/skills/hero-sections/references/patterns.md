# Hero Pattern Recipes

Vanilla HTML/CSS. Tokens (`--color-*`, `--font-*`, `--text-*`, `--space-*`, `--ease-*`) come from the site's token file. Adapt to Astro components or React as needed; the CSS is the point.

Shared base:

```css
.hero { min-height: min(100svh, 900px); display: grid; align-content: center; padding: var(--space-8) var(--space-5); }
.hero h1 { font: 600 var(--text-4xl)/1.02 var(--font-display); letter-spacing: -0.02em; max-width: 14ch; text-wrap: balance; }
.hero p.lead { font-size: var(--text-lg); max-width: 48ch; color: var(--color-text-muted); }
.hero .cta { display: flex; gap: var(--space-3); flex-wrap: wrap; margin-top: var(--space-5); }
@media (max-width: 480px) { .hero .cta > * { flex: 1 1 100%; } }
```

## [1] Type-only statement
```html
<section class="hero hero-type">
  <p class="eyebrow">Studio for considered brands</p>
  <h1>We design identities that outlast trends.</h1>
  <div class="cta"><a class="btn btn-primary" href="#contact">Start a project</a><a class="link" href="#work">See work →</a></div>
</section>
```
```css
.hero-type h1 { font-size: clamp(3rem, 10vw, 9rem); max-width: 12ch; }
.hero-type { grid-template-columns: minmax(0, 10fr) minmax(0, 2fr); } /* asymmetric: leave a deliberate empty column */
```

## [2] Split 7/5
```html
<section class="hero hero-split">
  <div><p class="eyebrow">…</p><h1>…</h1><p class="lead">…</p><div class="cta">…</div><p class="proof">…</p></div>
  <figure class="visual"><!-- inline SVG placeholder, data-replace="1200x1400, portrait…" --></figure>
</section>
```
```css
.hero-split { grid-template-columns: 7fr 5fr; gap: var(--space-7); align-items: center; }
.hero-split .visual { clip-path: inset(0 round var(--radius-xl)); } /* or polygon() for a tilted edge */
@media (max-width: 768px) { .hero-split { grid-template-columns: 1fr; } .visual { order: 2; } }
```

## [3] Masthead
```html
<header class="masthead">
  <div class="dateline"><span>Vol. 3</span><span>Est. 2019</span><span>Portland, OR</span></div>
  <h1>Bread, made slowly.</h1>
  <figure class="lead-image">…</figure>
  <p class="byline">A neighborhood bakery — open Wed–Sun</p>
</header>
```
```css
.dateline { display: flex; justify-content: space-between; border-block: 1px solid var(--color-border); padding: .5rem 0; font: 500 var(--text-xs)/1 var(--font-mono); text-transform: uppercase; letter-spacing: .1em; }
.masthead h1 { font-size: clamp(3.5rem, 12vw, 11rem); text-align: center; margin: var(--space-6) 0; }
```

## [4] Full-bleed image + panel
```css
.hero-bleed { position: relative; isolation: isolate; }
.hero-bleed .bg { position: absolute; inset: 0; z-index: -1; object-fit: cover; }
.hero-bleed .panel { background: color-mix(in oklab, var(--color-bg) 92%, transparent); backdrop-filter: blur(12px); padding: var(--space-6); max-width: 36rem; margin: 0 0 0 auto; }
```
Never put text directly on the image; the panel guarantees contrast.

## [5] Full-viewport word
```css
.hero-word { min-height: 100svh; display: grid; place-items: center; }
.hero-word h1 { font-size: clamp(5rem, 22vw, 26rem); line-height: .85; letter-spacing: -0.04em; }
.hero-word .corner { position: absolute; bottom: var(--space-5); left: var(--space-5); max-width: 28ch; }
.scroll-hint { position: absolute; bottom: var(--space-4); right: var(--space-5); animation: nudge 1.6s var(--ease-in-out) infinite; }
@keyframes nudge { 50% { transform: translateY(6px); } }
```

## [6] Marquee ticker
```html
<div class="marquee" aria-hidden="true"><div class="track"><span>Branding</span><span>Web</span><span>Motion</span><span>Branding</span><span>Web</span><span>Motion</span></div></div>
```
```css
.marquee { overflow: hidden; border-block: 2px solid currentColor; white-space: nowrap; }
.track { display: inline-flex; gap: 3rem; padding: .75rem 0; animation: scroll 18s linear infinite; }
.track span::after { content: "✦"; margin-left: 3rem; }
@keyframes scroll { to { transform: translateX(-50%); } }
@media (prefers-reduced-motion: reduce) { .track { animation: none; } }
```
Duplicate the content once so `-50%` loops seamlessly. Provide the list in an accessible form elsewhere (the marquee is `aria-hidden`).

## [7] Bento
```css
.bento { display: grid; grid-template-columns: repeat(6, 1fr); grid-auto-rows: 160px; gap: var(--space-3); }
.bento > :nth-child(1) { grid-column: span 4; grid-row: span 2; }
.bento > :nth-child(2) { grid-column: span 2; }
.bento > :nth-child(3) { grid-column: span 2; }
.bento > :nth-child(4) { grid-column: span 3; }
.bento > :nth-child(5) { grid-column: span 3; }
.bento > * { border: 1px solid var(--color-border); border-radius: var(--radius-lg); padding: var(--space-4); background: var(--color-surface); }
@media (max-width: 768px) { .bento { grid-template-columns: repeat(2, 1fr); } .bento > * { grid-column: span 2 !important; grid-row: auto !important; } }
```

## [8] Product-first
```css
.hero-product { grid-template-rows: 1fr auto; min-height: 100svh; }
.hero-product .visual { width: 100%; height: 100%; object-fit: contain; }
.hero-product .caption { display: flex; justify-content: space-between; align-items: end; padding-top: var(--space-4); border-top: 1px solid var(--color-border); }
.hero-product h1 { font-size: var(--text-2xl); }
```

## [9] Terminal
```html
<h1 class="typed"><span data-text="Ship docs that stay in sync."></span><span class="cursor">▍</span></h1>
<pre class="cmd"><code>$ npx docsync init</code><button class="copy" aria-label="Copy">⧉</button></pre>
```
```css
.cursor { animation: blink 1s steps(1) infinite; } @keyframes blink { 50% { opacity: 0; } }
```
```js
const el = document.querySelector('.typed span'); const t = el.dataset.text; let i = 0;
if (matchMedia('(prefers-reduced-motion: reduce)').matches) el.textContent = t; else (function tick(){ el.textContent = t.slice(0, ++i); if (i < t.length) setTimeout(tick, 35 + Math.random()*40); })();
```

## [10] Arched / masked image
```css
.arch { aspect-ratio: 4/5; overflow: hidden; border-radius: 999px 999px var(--radius-md) var(--radius-md); }
.blob { clip-path: path("M421 20c90 30 140 120 120 210s-110 150-210 140S20 300 30 200 331-10 421 20z"); }
```

## [11] Diagonal color split
```css
.hero-diag { background: linear-gradient(112deg, var(--color-primary) 0 55%, var(--color-bg) 55% 100%); color: var(--color-on-primary); }
.hero-diag h1 { mix-blend-mode: difference; color: #fff; }
```

## [12] Sticker collage
```css
.collage { position: relative; min-height: 100svh; }
.collage .stick { position: absolute; width: clamp(120px, 22vw, 320px); box-shadow: 0 10px 30px rgba(0,0,0,.15); border: 6px solid #fff; }
.collage .stick:nth-child(1) { top: 8%; left: 6%; rotate: -8deg; }
.collage .stick:nth-child(2) { top: 40%; right: 10%; rotate: 6deg; }
.collage .stick:nth-child(3) { bottom: 10%; left: 30%; rotate: -3deg; }
.collage h1 { position: relative; z-index: 2; font-size: clamp(3rem, 12vw, 10rem); }
```

## [13] Centered frame
```css
.hero-frame { text-align: center; padding: var(--space-8); }
.hero-frame .frame { border: 1px solid var(--color-accent); outline: 1px solid var(--color-accent); outline-offset: 6px; padding: var(--space-7) var(--space-6); max-width: 52rem; margin-inline: auto; }
.hero-frame h1::before, .hero-frame h1::after { content: ""; display: block; width: 80px; height: 1px; background: var(--color-accent); margin: var(--space-4) auto; }
```

## [14] Scroll-pinned story
```css
.story { height: 300vh; }
.story .pin { position: sticky; top: 0; height: 100svh; display: grid; grid-template-columns: 1fr 1fr; align-items: center; }
.story .frames > * { position: absolute; inset: 0; opacity: 0; transition: opacity .6s var(--ease-out); }
.story .frames > .is-active { opacity: 1; }
```
```js
const frames = [...document.querySelectorAll('.story .frames > *')];
addEventListener('scroll', () => { const s = document.querySelector('.story'); const p = Math.min(1, Math.max(0, -s.getBoundingClientRect().top / (s.offsetHeight - innerHeight))); const idx = Math.min(frames.length-1, Math.floor(p * frames.length)); frames.forEach((f,i)=>f.classList.toggle('is-active', i===idx)); }, { passive: true });
```
Where supported, prefer CSS `animation-timeline: scroll()` and skip the JS.
