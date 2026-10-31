/**
 * Types for the vendored `<noise-backdrop>` element. Importing the module
 * defines the element as a side effect; only the browser may import it.
 */
export declare class NoiseBackdrop extends HTMLElement {
  /** True once it is drawing; false if it fell back to the plain background. */
  readonly ready: Promise<boolean>;
  /** Draws the frame at `seconds` and stops the clock. */
  setTime(seconds: number): boolean;
  /** GPU time of one frame, in milliseconds; null without WebGL. */
  frameTime(frames?: number): number | null;
}

export declare const PRESETS: Record<string, Record<string, string | number>>;
