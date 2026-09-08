import { useEffect, useRef, useState } from "react";

/**
 * The travelling square.
 *
 * The home page's one idea: the blue square that is the period in the "M."
 * monogram detaches and becomes, in turn, the caret in a request field, the
 * preview panel, the approve button, the live dot, and finally the period in
 * the masthead's mark — where it stays. Every blue surface on the page is this
 * one object at a different point in its life.
 *
 * This component renders *only* the moving square and its echoes. The four
 * resting shapes are real elements in the HTML with real blue squares inside
 * them, authored in Astro; when this mounts it sets `data-flying` on <html>,
 * which hides those four (they keep their space, so nothing reflows) and lets
 * this one stand in. If it never mounts — reduced motion, a JavaScript error,
 * a slow phone that gave up — the page still shows all four steps. Nothing
 * here is load-bearing for reading the page, which is the rule the Next.js
 * version broke.
 *
 * The square is given weight on purpose. It lags the scroll, leans into a
 * turn, squashes along the direction it is travelling, trails echoes of where
 * it just was, and settles when it arrives. A square welded to the wheel would
 * read as a scroll-position indicator; one with mass reads as an object being
 * carried through a process, which is the thing the page is arguing.
 */

type Stop = {
  /** Document coordinates, so they survive scrolling. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Scroll position at which the square should be exactly on this stop. */
  at: number;
  /** 0 = solid fill, 1 = 2px outline with nothing inside. */
  hollow: number;
  /**
   * The masthead is `position: sticky`, so it has no fixed place in the
   * document — storing it in document coordinates sends the square thousands
   * of pixels off the top of the page. Its y is held in viewport coordinates
   * instead and rebased against the scroll position every frame.
   */
  fixed?: boolean;
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Echoes of where the square just was. Each lags a little further behind. */
const TRAIL = 5;

export default function SquareFlight() {
  const el = useRef<HTMLDivElement>(null);
  const ghosts = useRef<(HTMLDivElement | null)[]>([]);
  const stops = useRef<Stop[]>([]);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    // Reduced motion is checked before anything is measured or shown: the
    // static composition is already correct, so the cheapest correct thing to
    // do is nothing at all.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const origin = document.querySelector<SVGRectElement>('[data-square="origin"]');
    const home = document.querySelector<HTMLElement>('[data-square="home"]');
    const slots = Array.from(document.querySelectorAll<HTMLElement>("[data-dock] .dock__square"));
    if (!origin || slots.length === 0) return;

    const measure = () => {
      const sy = window.scrollY;
      const vh = window.innerHeight;

      const toStop = (node: Element, at: number, hollow = 0): Stop => {
        const r = node.getBoundingClientRect();
        return { x: r.left + window.scrollX, y: r.top + sy, w: r.width, h: r.height, at, hollow };
      };

      // The square sits on a dock exactly when that dock's slot is centred in
      // the viewport, so the stop's scroll position is derived from the slot's
      // own place in the document rather than from a hand-tuned constant.
      const dockAt = (node: Element) => {
        const r = node.getBoundingClientRect();
        return Math.max(0, r.top + sy + r.height / 2 - vh / 2);
      };

      const next: Stop[] = [toStop(origin, 0)];
      slots.forEach((slot, i) => {
        // Step 02 is the preview panel: the square fills it and then hollows
        // out, revealing the preview that was underneath the whole time.
        next.push(toStop(slot, dockAt(slot), i === 1 ? 1 : 0));
      });

      // The last leg: having gone live, the square rises into the masthead and
      // becomes the period of the small mark, where it stays for the rest of
      // the page. It leaves once the final step is a viewport behind.
      if (home) {
        const r = home.getBoundingClientRect();
        next.push({
          x: r.left,
          y: r.top,
          w: r.width,
          h: r.height,
          at: next[next.length - 1]!.at + vh * 0.9,
          hollow: 0,
          fixed: true,
        });
      }

      stops.current = next;
    };

    // Type is still settling on first paint, and the lockup's size depends on
    // it — measuring before the webfont lands docks the square to the fallback.
    const remeasure = () => requestAnimationFrame(measure);
    measure();
    document.fonts?.ready.then(remeasure);

    document.documentElement.setAttribute("data-flying", "");
    setArmed(true);

    // Position is lerped toward the target every frame rather than set from
    // scroll directly. That is the "scrub" feel — the square lags the scroll
    // slightly and settles, instead of being welded to the wheel.
    let raf = 0;
    let cur: { x: number; y: number; w: number; h: number; hollow: number } | null = null;
    let vx = 0;
    let vy = 0;
    let lastScreenY = 0;
    const history: { x: number; y: number; w: number; h: number }[] = [];

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const list = stops.current;
      const node = el.current;
      if (!node || list.length < 2) return;

      const sy = window.scrollY;

      // Find the segment this scroll position falls in and interpolate across it.
      let i = 0;
      while (i < list.length - 2 && sy > list[i + 1]!.at) i++;
      const a = list[i]!;
      const b = list[i + 1]!;
      const span = b.at - a.at;
      const t = span <= 0 ? 1 : clamp((sy - a.at) / span, 0, 1);
      // Ease the segment so the square decelerates into each dock instead of
      // arriving at constant speed and stopping dead.
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

      // A viewport-anchored stop is rebased onto the current scroll so it
      // stays put on screen while the document slides underneath it.
      const ay = a.fixed ? a.y + sy : a.y;
      const by = b.fixed ? b.y + sy : b.y;

      const target = {
        x: lerp(a.x, b.x, e),
        y: lerp(ay, by, e),
        w: lerp(a.w, b.w, e),
        h: lerp(a.h, b.h, e),
        hollow: lerp(a.hollow, b.hollow, e),
      };

      const prevX = cur ? cur.x : target.x;
      cur = cur
        ? {
            x: lerp(cur.x, target.x, 0.16),
            y: lerp(cur.y, target.y, 0.16),
            w: lerp(cur.w, target.w, 0.16),
            h: lerp(cur.h, target.h, 0.16),
            hollow: lerp(cur.hollow, target.hollow, 0.16),
          }
        : target;

      // Velocity is measured on screen, not in the document: what the square
      // looks like it is doing is what should drive how it deforms. Smoothed,
      // or every wheel tick reads as a jolt.
      const screenY = cur.y - sy;
      vx = lerp(vx, cur.x - prevX, 0.25);
      vy = lerp(vy, screenY - lastScreenY, 0.25);
      lastScreenY = screenY;

      const speed = Math.hypot(vx, vy);
      const vertical = Math.abs(vy) >= Math.abs(vx);

      // Squash along the direction of travel, stretch across it — the classic
      // weight cue. Capped, because past a point it stops reading as mass and
      // starts reading as a rendering fault.
      const stretch = clamp(speed / 90, 0, 0.26);
      const sx = vertical ? 1 - stretch * 0.6 : 1 + stretch * 0.6;
      const sy2 = vertical ? 1 + stretch * 0.6 : 1 - stretch * 0.6;
      // Lean into a turn. Sideways motion tilts it; straight travel does not.
      const rot = clamp(vx * 0.22, -9, 9);

      node.style.transform = `translate3d(${cur.x}px, ${screenY}px, 0) rotate(${rot}deg) scale(${sx}, ${sy2})`;
      node.style.width = `${cur.w}px`;
      node.style.height = `${cur.h}px`;
      node.style.borderWidth = `${cur.hollow * 2}px`;
      node.style.backgroundColor = cur.hollow > 0.5 ? "transparent" : "";

      // Publish where the square is, so other effects can answer to it — the
      // hero's field brightens around it as it passes.
      const root = document.documentElement.style;
      root.setProperty("--sq-x", `${Math.round(cur.x + cur.w / 2)}px`);
      root.setProperty("--sq-y", `${Math.round(screenY + cur.h / 2)}px`);

      // Echoes: the same shape a few frames back, fading out. They only appear
      // while the square is genuinely moving, so a parked square is a single
      // clean object and the "one blue square" rule still reads at every dock.
      history.unshift({ x: cur.x, y: screenY, w: cur.w, h: cur.h });
      if (history.length > TRAIL * 4) history.length = TRAIL * 4;
      const show = clamp((speed - 1.5) / 14, 0, 1);
      for (let g = 0; g < TRAIL; g++) {
        const gn = ghosts.current[g];
        const hp = history[(g + 1) * 3];
        if (!gn || !hp) continue;
        gn.style.transform = `translate3d(${hp.x}px, ${hp.y}px, 0)`;
        gn.style.width = `${hp.w}px`;
        gn.style.height = `${hp.h}px`;
        gn.style.opacity = `${show * (1 - g / TRAIL) * 0.4}`;
      }
    };
    raf = requestAnimationFrame(frame);

    const ro = new ResizeObserver(remeasure);
    ro.observe(document.body);
    window.addEventListener("resize", remeasure, { passive: true });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", remeasure);
      document.documentElement.removeAttribute("data-flying");
    };
  }, []);

  if (!armed) return null;
  return (
    <>
      {Array.from({ length: TRAIL }, (_, g) => (
        <div
          key={g}
          ref={(n) => {
            ghosts.current[g] = n;
          }}
          className="flyer flyer--ghost"
          aria-hidden="true"
        />
      ))}
      <div
        ref={el}
        className="flyer"
        aria-hidden="true"
        style={{ borderStyle: "solid", borderColor: "var(--blue)", borderWidth: 0 }}
      />
    </>
  );
}
