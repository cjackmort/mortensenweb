"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

function useRevealRef<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          el.setAttribute("data-in", "true");
          observer.disconnect();
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -10% 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return ref;
}

function revealStyle(index: number): CSSProperties {
  // A single custom property drives the stagger, so N siblings need one prop
  // each rather than N separate animation-delay rules.
  return { "--d": `${index * 70}ms` } as CSSProperties;
}

type RevealProps = {
  children: ReactNode;
  /** Position within a staggered group. */
  index?: number;
  className?: string;
};

/**
 * Fades a block in the first time it crosses the viewport, then stops
 * watching it — a one-shot entrance, not a replay-on-every-scroll peekaboo.
 * `prefers-reduced-motion` is handled entirely by the `.reveal` rule in
 * globals.css, so there is no JS branch to keep in sync with it.
 */
export function Reveal({ children, index = 0, className }: RevealProps) {
  const ref = useRevealRef<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={className ? `reveal ${className}` : "reveal"}
      style={revealStyle(index)}
    >
      {children}
    </div>
  );
}

/**
 * Same as `Reveal`, rendered as `<li>` — for lists (`.steps`) where a
 * wrapping `<div>` would land outside the `<ol>`'s allowed children.
 */
export function RevealItem({ children, index = 0, className }: RevealProps) {
  const ref = useRevealRef<HTMLLIElement>();
  return (
    <li
      ref={ref}
      className={className ? `reveal ${className}` : "reveal"}
      style={revealStyle(index)}
    >
      {children}
    </li>
  );
}
