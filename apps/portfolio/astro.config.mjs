import { defineConfig, fontProviders } from "astro/config";
import sitemap from "@astrojs/sitemap";
import react from "@astrojs/react";

/**
 * The public agency site.
 *
 * Astro, static. The previous version was a Next.js export that shipped 457 KB
 * of JavaScript to render five pages of copy, and hid every section behind an
 * observer until that JavaScript had run — a blank page on a slow phone. This
 * one keeps that lesson: the HTML is the page, the CSS does most of the
 * motion, and no section is parked at opacity 0 waiting for a script.
 *
 * React is here for one job — the home page's scroll set-pieces, which are
 * stateful enough that hand-written observers would be worse. It is loaded per
 * island, so /pricing/ and /services/ still ship zero framework runtime; only
 * the components explicitly marked `client:*` cost anything. If an island ever
 * becomes the only way to read something on the page, that is the mistake the
 * Next.js version made and it should be reverted, not optimised.
 *
 * `trailingSlash: "always"` keeps the URLs the old site had (/work/, /pricing/)
 * so nothing that linked to them breaks.
 */
export default defineConfig({
  site: "https://mortensenweb.com",
  trailingSlash: "always",
  build: { format: "directory", inlineStylesheets: "always" },
  vite: {
    build: {
      /*
       * esbuild, not Astro 7's default Lightning CSS.
       *
       * Lightning folds `animation-timeline` into the `animation` shorthand —
       * `animation: linear both card-turn view()`. That syntax was in an early
       * Level 2 draft and was then removed, so Chrome rejects the declaration
       * outright and takes `animation-name` with it. Every scroll-driven
       * animation on the home page died in the production build while dev
       * looked perfect, because dev does not minify.
       *
       * The page still rendered correctly — everything just sat at its resting
       * state, which is the designed fallback — so nothing looked broken. That
       * is exactly why this is pinned rather than left to the default.
       */
      cssMinify: "esbuild",
    },
  },
  /*
   * The typefaces, fetched from Google Fonts at build time and served from
   * this site. Linking Google's stylesheet instead cost every first visit a
   * render-blocking request to a second origin and then a third for the
   * files — Lighthouse put it at 2.2 s of a phone's first paint. Served from
   * here, the files are immutable under /_astro/, the important weights are
   * preloaded, and Astro sizes a local fallback to each face's metrics so
   * the swap does not shift the page. Only the weights the CSS sets.
   */
  fonts: [
    {
      provider: fontProviders.google(),
      name: "Schibsted Grotesk",
      cssVariable: "--font-schibsted",
      weights: [400, 500],
      styles: ["normal"],
      fallbacks: ["Helvetica Neue", "Helvetica", "Arial", "sans-serif"],
    },
    {
      provider: fontProviders.google(),
      name: "JetBrains Mono",
      cssVariable: "--font-jetbrains-mono",
      weights: [400, 500],
      styles: ["normal"],
      fallbacks: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
    },
    {
      // The home page's display face, for the lockup only.
      provider: fontProviders.google(),
      name: "Jost",
      cssVariable: "--font-jost",
      weights: [400],
      styles: ["normal"],
      fallbacks: ["Helvetica", "Arial", "sans-serif"],
    },
  ],
  integrations: [
    react(),
    sitemap({
      // The form's thank-you page is not a page anyone should be sent to.
      filter: (page) => !page.includes("/thanks/"),
    }),
  ],
  // Sharp is a devDependency; images in the work grid are pre-sized files in
  // public/ and served as authored, so the service is only there for the
  // occasional <Image> and the OG image build.
});
