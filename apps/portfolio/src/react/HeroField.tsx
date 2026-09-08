import { useEffect, useRef, useState } from "react";

/**
 * The hero's field of squares.
 *
 * The static CSS grid behind the lockup is a background image, and a
 * background image cannot answer to anything. This replaces it with the same
 * grid on a canvas, where each square can respond to two things: the pointer,
 * and the travelling square as it goes past (SquareFlight publishes its
 * position as `--sq-x` / `--sq-y`).
 *
 * The point is not decoration. The site's argument is that someone is looking
 * after your website — a ground that reacts is the cheapest possible way to
 * say "this is live, not a picture of a website". It stays monochrome and very
 * low contrast so it never competes with the lockup sitting on top of it.
 *
 * If this never mounts, the CSS background grid underneath is still there and
 * the hero looks exactly as designed, just still. That is why the canvas fades
 * itself in rather than the CSS grid being removed.
 */

const PITCH = 32;
const SIZE = 3;
/** How far the pointer's influence reaches, in pixels. */
const REACH = 190;

export default function HeroField() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const canvas = ref.current;
    // NOT parentElement: Astro wraps an island in <astro-island>, which is an
    // unstyled custom element and therefore `display: inline` with a zero-size
    // box. Measuring that gives a 0x0 canvas that silently draws nothing.
    const host = canvas?.closest<HTMLElement>(".hero-sq");
    if (!canvas || !host) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    setArmed(true);
    // Tells the CSS to fade out the static background grid this replaces.
    host.dataset.field = "on";

    let w = 0;
    let h = 0;
    let dpr = 1;
    const resize = () => {
      const r = host.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = r.width;
      h = r.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    // Pointer is tracked in the host's own coordinates and eased, so the field
    // keeps moving for a moment after the mouse stops rather than freezing.
    let px = -9999;
    let py = -9999;
    let ex = px;
    let ey = py;
    let hasPointer = false;

    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const r = host.getBoundingClientRect();
      px = e.clientX - r.left;
      py = e.clientY - r.top;
      hasPointer = true;
    };
    const onLeave = () => {
      hasPointer = false;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    host.addEventListener("pointerleave", onLeave, { passive: true });

    let raf = 0;
    let time = 0;
    let fade = 0;

    const frame = () => {
      raf = requestAnimationFrame(frame);
      time += 0.006;
      // Fade in on first frames so the swap from CSS grid to canvas is not a
      // visible pop.
      fade = Math.min(1, fade + 0.04);

      if (hasPointer) {
        ex += (px - ex) * 0.12;
        ey += (py - ey) * 0.12;
      } else {
        // Drift the influence off-screen instead of snapping it away.
        ey += (h * 1.6 - ey) * 0.03;
      }

      // Where the travelling square is right now, in this canvas's space.
      const root = getComputedStyle(document.documentElement);
      const hostRect = host.getBoundingClientRect();
      const sqx = parseFloat(root.getPropertyValue("--sq-x")) - hostRect.left;
      const sqy = parseFloat(root.getPropertyValue("--sq-y")) - hostRect.top;
      const hasSq = Number.isFinite(sqx) && Number.isFinite(sqy);

      ctx.clearRect(0, 0, w, h);

      for (let gx = 0; gx < w + PITCH; gx += PITCH) {
        for (let gy = 0; gy < h + PITCH; gy += PITCH) {
          // A slow diagonal wave keeps the field alive with no input at all.
          const wave = Math.sin(gx * 0.012 + gy * 0.014 + time * 2) * 0.5 + 0.5;
          let energy = wave * 0.12;

          const dx = gx - ex;
          const dy = gy - ey;
          const d = Math.hypot(dx, dy);
          if (d < REACH) {
            const near = 1 - d / REACH;
            energy += near * near * 0.9;
          }

          if (hasSq) {
            const sd = Math.hypot(gx - sqx, gy - sqy);
            if (sd < REACH * 0.8) {
              const near = 1 - sd / (REACH * 0.8);
              energy += near * near * 0.75;
            }
          }

          if (energy < 0.02) continue;
          const size = SIZE + energy * 3.4;
          const alpha = (0.12 + energy * 0.5) * fade;

          // The field is the brand's off-white; only the square is ever blue.
          ctx.fillStyle = `rgba(237, 239, 234, ${Math.min(alpha, 0.72)})`;
          const off = (size - SIZE) / 2;
          ctx.fillRect(gx - off, gy - off, size, size);
        }
      }
    };
    raf = requestAnimationFrame(frame);

    const ro = new ResizeObserver(resize);
    ro.observe(host);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
      delete host.dataset.field;
    };
  }, []);

  return <canvas ref={ref} className="hero-sq__field" data-on={armed ? "" : undefined} aria-hidden="true" />;
}
