# Interactive Animation Recipes (verified)

Rendered and inspected in Chromium; full working page in `examples/recipes.html`. All pointer effects are gated by `prefers-reduced-motion` and degrade to nothing on touch.

## Content over decor (the rule that fixes most "looks bad" cases)

Any surface that carries text and sits on an animated background gets its own ground:
```css
.card{background:linear-gradient(180deg,rgb(var(--surface-rgb)/.85),rgb(var(--surface-rgb)/.85));backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.08)}
```
Or the decor layer is kept ≤ 0.4 opacity where it can cross text, or a scrim gradient sits under the text column. Verify by screenshot — if muted text (`--color-text-muted`) is hard to read anywhere, the effect is wrong, not the text.

## 1. 3D tilt card + glare + cursor-tracking glow border

Tilt from pointer position (max ±8–10°), a soft glare highlight, and a 1px border that lights up near the cursor using `mask-composite` (no blurry box-shadow halo).

```css
.card{position:relative;border-radius:18px;transform-style:preserve-3d;transition:transform .35s var(--ease-out);will-change:transform}
.card::before{content:"";position:absolute;inset:-1px;border-radius:inherit;padding:1px;
 background:radial-gradient(240px circle at var(--gx,50%) var(--gy,50%),var(--a),transparent 60%);
 -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;opacity:0;transition:opacity .4s}
.card:hover::before{opacity:1}
.card .glare{position:absolute;inset:0;border-radius:inherit;pointer-events:none;opacity:0;transition:opacity .4s;
 background:radial-gradient(400px circle at var(--gx,50%) var(--gy,50%),rgba(255,255,255,.14),transparent 55%)}
.card:hover .glare{opacity:1}
```
```js
const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
document.querySelectorAll('.card').forEach(c=>{
 c.addEventListener('pointermove',e=>{const r=c.getBoundingClientRect();const x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height;
  c.style.setProperty('--gx',x*100+'%');c.style.setProperty('--gy',y*100+'%');
  if(!reduce&&e.pointerType==='mouse')c.style.transform=`perspective(900px) rotateX(${(0.5-y)*8}deg) rotateY(${(x-0.5)*10}deg) translateY(-2px)`;});
 c.addEventListener('pointerleave',()=>c.style.transform='');});
```
Use on cards in a grid of ≤ 6; not on text-heavy blocks.

## 2. Magnetic button

The button drifts toward the cursor (25–35% of the offset) and snaps back with an expo ease. Arrow nudges on hover.
```css
.btn{transition:transform .5s var(--ease-expo),box-shadow .5s;will-change:transform}
.btn .arr{display:inline-block;transition:transform .35s var(--ease-out)}.btn:hover .arr{transform:translateX(5px)}
```
```js
document.querySelectorAll('.magnetic').forEach(b=>{b.addEventListener('pointermove',e=>{if(reduce||e.pointerType!=='mouse')return;const r=b.getBoundingClientRect();b.style.transform=`translate(${(e.clientX-r.left-r.width/2)*.25}px,${(e.clientY-r.top-r.height/2)*.35}px)`;});b.addEventListener('pointerleave',()=>b.style.transform='');});
```
Only on primary CTAs. Never on nav links (it makes them hard to hit).

## 3. Line-by-line headline reveal
Wrap each line in an `overflow:hidden` span; the inner span rises from 110%.
```html
<h1 class="lines"><span><span style="--i:0">Aurora mesh</span></span><span><span style="--i:1">+ film grain.</span></span></h1>
```
```css
.lines>span{display:block;overflow:hidden}
.lines>span>span{display:block;transform:translateY(110%);animation:up .9s var(--ease-expo) forwards;animation-delay:calc(var(--i)*90ms)}
@keyframes up{to{transform:none}}
```
Split lines by hand (or with a tiny script measuring `getClientRects`) — never by word for headlines longer than 4 words; word-splits jitter.

## 4. Shimmer text (one word only)
```css
.shimmer{background:linear-gradient(110deg,var(--text) 35%,var(--a) 50%,var(--text) 65%);background-size:250% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:shimmer 4s linear infinite}
@keyframes shimmer{from{background-position:120% 0}to{background-position:-120% 0}}
```

## 5. Staggered reveal on scroll (once)
```css
.js .reveal{opacity:0;transform:translateY(22px);transition:opacity .7s var(--ease-out),transform .7s var(--ease-out);transition-delay:calc(var(--i)*70ms)}
.js .reveal.in{opacity:1;transform:none}
```
```js
document.documentElement.classList.add('js');
const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target);}}),{rootMargin:'0px 0px -10% 0px'});
document.querySelectorAll('.reveal').forEach((el,i)=>{el.style.setProperty('--i',i%6);io.observe(el);});
```
Cap the stagger index at 5–6 so a long grid doesn't take seconds to appear. Rise distance 16–24px; more looks like a slideshow.

## 6. Link underline grow
```css
a.u{background:linear-gradient(currentColor,currentColor) no-repeat 0 100%/0 1px;transition:background-size .35s var(--ease-out)}
a.u:hover{background-size:100% 1px}
```

## 7. Nav sliding indicator
A single absolutely positioned pill moved to the hovered/active item via `transform` (measure `offsetLeft/offsetWidth`), 300ms ease-out. One element moves; items themselves never animate.

## 8. Image hover: scale + crossfade
```css
figure{overflow:hidden}figure img{transition:transform .6s var(--ease-out)}figure:hover img{transform:scale(1.04)}
.swap img:last-child{position:absolute;inset:0;opacity:0;transition:opacity .5s}.swap:hover img:last-child{opacity:1}
```

## 9. Accordion (FAQ) height animation
Use `<details>`; animate with the `interpolate-size` / `calc-size()` where supported, else a small JS that sets `max-height` from `scrollHeight` on toggle. 300ms ease-out. Rotate the chevron 180°.

## 10. Number counter
```js
function count(el){const end=+el.dataset.to,dur=1200,t0=performance.now(),fmt=new Intl.NumberFormat();
 if(reduce){el.textContent=fmt.format(end);return;}
 (function f(t){const p=Math.min(1,(t-t0)/dur),e=1-Math.pow(1-p,3);el.textContent=fmt.format(Math.round(end*e));if(p<1)requestAnimationFrame(f);})(t0);}
```
Trigger once via IntersectionObserver. Ease-out cubic so the last digits settle instead of flicking.

## 11. Custom cursor (only when the archetype asks: Luxury, Brutalist, Cinematic)
A 12px dot that follows the pointer with lerp (0.15), grows to 48px with a label ("View", "Drag") over interactive elements; the native cursor stays visible unless the element is fully custom. Disabled entirely on touch and for reduced motion.

## 12. Page transitions
Astro: `<ClientRouter />` + `transition:name` on hero images and `transition:persist` on the header. Next.js: wrap `router.push` in `document.startViewTransition` when available. Duration 250–400ms; a fade + 8px rise is enough.

## Testing an interactive effect

Render with Playwright, move the mouse across the element (`page.mouse.move`) in 3–4 steps with 100ms waits, screenshot at the end, and *look*: does the highlight track the pointer, is there no jump on `pointerleave`, does text stay readable, is nothing clipped by `overflow:hidden`? Then emulate `reduced-motion` and confirm the page is complete and static.
