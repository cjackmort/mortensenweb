# Background Animation Recipes (verified)

All of these were rendered and inspected in Chromium. `examples/recipes.html` contains the full working page — open it in Playwright and screenshot it to see the expected look before adapting. Colors reference the site's tokens; swap `--p/--a/--m` for the palette's primary/accent/support.

Every background layer follows the **decor contract**: `position:absolute; inset:0; z-index:0; pointer-events:none` inside a section with `position:relative; isolation:isolate; overflow:hidden`, and content sits at `z-index:2`. Text never sits directly on the brightest area of a background — add a scrim or a surface (see `interactive.md` "content over decor").

## 1. Aurora gradient mesh (+ grain)

What makes it look right: **blur ≥ 80px**, `mix-blend-mode: screen` on dark (or `multiply` on light), each blob on a *different* 20–30s `alternate` loop so they never sync, overall opacity 0.5–0.65, and a **scrim** gradient under the text column.

```css
.aurora{position:absolute;inset:-20%;z-index:0;filter:blur(90px);opacity:.6;pointer-events:none}
.aurora i{position:absolute;border-radius:50%;width:55vw;height:55vw;mix-blend-mode:screen}
.aurora i:nth-child(1){background:var(--p);left:-10%;top:-10%;animation:drift1 22s ease-in-out infinite alternate}
.aurora i:nth-child(2){background:var(--a);right:-10%;top:10%;width:45vw;height:45vw;animation:drift2 26s ease-in-out infinite alternate}
.aurora i:nth-child(3){background:var(--m);left:30%;bottom:-30%;width:40vw;height:40vw;animation:drift3 30s ease-in-out infinite alternate}
@keyframes drift1{to{transform:translate(18vw,10vh) scale(1.15)}}
@keyframes drift2{to{transform:translate(-14vw,16vh) scale(.9)}}
@keyframes drift3{to{transform:translate(-10vw,-18vh) scale(1.2)}}
.scrim{position:absolute;inset:0;z-index:1;pointer-events:none;background:linear-gradient(90deg,rgb(var(--bg-rgb)/.85) 0%,rgb(var(--bg-rgb)/.45) 45%,transparent 70%)}
```
Grain overlay (hides gradient banding; 0.25–0.4 opacity, `mix-blend-mode: overlay`):
```css
.grain{position:absolute;inset:0;z-index:1;pointer-events:none;opacity:.35;mix-blend-mode:overlay;
 background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 .5 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
```
Light-theme variant: blobs at 0.35 opacity, `mix-blend-mode: multiply`, pastel versions of the palette. Mobile: reduce blob size to 90vw and keep two blobs — blur is expensive; test on a throttled device.

## 2. Dot grid with cursor spotlight

Static faint grid + a brighter copy masked by a radial gradient that follows the pointer. No motion unless the user moves; feels alive; nearly free.

```css
.dots-base{position:absolute;inset:0;z-index:0;background-image:radial-gradient(rgba(255,255,255,.07) 1px,transparent 1.5px);background-size:28px 28px}
.dots{position:absolute;inset:0;z-index:0;background-image:radial-gradient(rgba(255,255,255,.28) 1px,transparent 1.5px);background-size:28px 28px;
 mask-image:radial-gradient(260px circle at var(--mx,50%) var(--my,50%),#000 0%,rgba(0,0,0,.25) 45%,transparent 75%);-webkit-mask-image:radial-gradient(260px circle at var(--mx,50%) var(--my,50%),#000 0%,rgba(0,0,0,.25) 45%,transparent 75%)}
```
```js
sec.addEventListener('pointermove',e=>{const r=sec.getBoundingClientRect();sec.style.setProperty('--mx',(e.clientX-r.left)+'px');sec.style.setProperty('--my',(e.clientY-r.top)+'px');});
```
Variants: line grid (`linear-gradient` in two directions, 1px, 64px cells), crosshatch, or use the mask to reveal a *color* layer instead of dots. On touch devices the spotlight sits at 50%/30% by default — that is fine.

## 3. Canvas soft orbs (the right kind of "particles")

Eight *large* soft orbs with additive blending on slow sine drift — not 200 tiny dots joined by lines (that look is dated and noisy). Capped at 30fps, paused off-screen, DPR capped at 1.5.

```js
const cv=document.querySelector('canvas.orbs'),ctx=cv.getContext('2d');let W,H,t=0,visible=true;
const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
const orbs=Array.from({length:8},(_,i)=>({x:Math.random(),y:Math.random(),r:.18+Math.random()*.16,c:[P,A,M][i%3],s:.4+Math.random()*.6,o:Math.random()*6}));
function size(){const d=Math.min(devicePixelRatio,1.5);W=cv.width=cv.clientWidth*d;H=cv.height=cv.clientHeight*d;}size();addEventListener('resize',size);
function draw(){if(!visible)return;t+=1/30;ctx.clearRect(0,0,W,H);ctx.globalCompositeOperation='lighter';
 for(const o of orbs){const x=(o.x+Math.sin(t*.12*o.s+o.o)*.12)*W,y=(o.y+Math.cos(t*.09*o.s+o.o)*.10)*H,r=o.r*Math.max(W,H);
  const g=ctx.createRadialGradient(x,y,0,x,y,r);g.addColorStop(0,o.c+'55');g.addColorStop(1,o.c+'00');ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,r,0,7);ctx.fill();}
 if(!reduce)setTimeout(()=>requestAnimationFrame(draw),1000/30);}
new IntersectionObserver(([e])=>{visible=e.isIntersecting;if(visible)draw();}).observe(cv);draw();
```
`P/A/M` are hex strings; the `'55'` suffix is alpha. On light themes use `globalCompositeOperation='multiply'` and pastel colors.

## 4. SVG blob morph

Two paths with the **same number of commands**, animated via CSS `d: path()` (Chromium/Safari; Firefox falls back to the static shape — acceptable). Keep opacity ≤ 0.4 and add a little blur so it reads as light, not a sticker.

```css
.blob{position:absolute;right:-5%;top:-10%;width:60%;z-index:0;opacity:.35;filter:blur(24px);pointer-events:none}
.blob path{fill:url(#bg);animation:morph 14s ease-in-out infinite alternate}
@keyframes morph{0%{d:path("M421,300Q380,420,260,430Q140,440,100,320Q60,200,170,140Q280,80,360,150Q440,220,421,300Z")}100%{d:path("M440,280Q420,400,300,450Q180,500,110,380Q40,260,140,170Q240,80,340,130Q440,180,440,280Z")}}
```

## 5. Giant parallax word

A section-sized word at 3–5% opacity moving at 0.1–0.2× scroll speed. Cheap, editorial, reads as intentional.

```css
.layer{position:absolute;inset:0;z-index:0;display:grid;place-items:center;font-size:22vw;font-weight:800;letter-spacing:-.05em;color:rgba(255,255,255,.04);pointer-events:none}
```
```js
let ticking=false;addEventListener('scroll',()=>{if(ticking)return;ticking=true;requestAnimationFrame(()=>{layers.forEach(l=>{const r=l.parentElement.getBoundingClientRect();l.style.transform=`translateY(${(r.top-innerHeight/2)*-l.dataset.speed}px)`;});ticking=false;});},{passive:true});
```
Prefer CSS `animation-timeline: view()` where supported and skip the JS.

## 6. Scroll progress bar
```css
.progress{position:fixed;top:0;left:0;height:3px;width:100%;background:linear-gradient(90deg,var(--a),var(--m));transform-origin:left;transform:scaleX(0);z-index:9}
@supports (animation-timeline: scroll()){.progress{animation:grow linear both;animation-timeline:scroll(root)}@keyframes grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}}
```

## 7. Animated gradient (subtle, for bands and buttons)
```css
.band{background:linear-gradient(120deg,var(--p),var(--a),var(--m),var(--p));background-size:300% 300%;animation:pan 18s ease-in-out infinite}
@keyframes pan{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}
```
Keep hues within ~90° of each other or it strobes. 15s+ durations. Never on body text backgrounds.

## 8. Conic rotating border (needs `@property`)
```css
@property --ang{syntax:"<angle>";initial-value:0deg;inherits:false}
.ring{padding:2px;border-radius:16px;background:conic-gradient(from var(--ang),transparent 0 60%,var(--a) 75%,var(--m) 85%,transparent 100%);animation:spin 5s linear infinite}
.ring>div{background:var(--bg);border-radius:14px}
@keyframes spin{to{--ang:360deg}}
```
Use on one element per page (a highlighted card or CTA), never on every card.

## 9. Marquee with edge fade
```css
.marquee{overflow:hidden;white-space:nowrap;mask-image:linear-gradient(90deg,transparent,#000 10%,#000 90%,transparent)}
.marquee .track{display:inline-flex;gap:56px;animation:mq 28s linear infinite}
@keyframes mq{to{transform:translateX(-50%)}}
```
Duplicate the items exactly once so `-50%` loops seamlessly; 25–40s for a full pass; pause on hover with `animation-play-state`.

## 10. Light-theme backgrounds

Dark backgrounds forgive a lot; light ones do not. On light grounds use: pastel aurora at 0.3–0.4 with `multiply`; ink-colored dot grids at 0.12; paper grain (`overlay` at 0.2); soft shadows instead of glows; and never animate saturated color under black text.

## Archetype pairing

Neo-Glass/Retro → 1, 3, 8 · Corporate → 2, 6 · Editorial/Newspaper → 5, grain · Organic/Craft → 4 · Brutalist → 9, hard-edged 7 · Cinematic → 5 + pinned scenes · Terminal → 2 (line grid) · Luxury → 1 at very low opacity + grain · Swiss/Japanese/Docs → none.
