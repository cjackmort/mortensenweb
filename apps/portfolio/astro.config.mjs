import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

/**
 * The public agency site.
 *
 * Astro, static. The previous version was a Next.js export that shipped 457 KB
 * of JavaScript to render five pages of copy, and hid every section behind an
 * observer until that JavaScript had run — a blank page on a slow phone. This
 * one ships no framework runtime at all: the HTML is the page, the CSS does
 * the motion, and the only script is the analytics tag plus a few hundred
 * bytes for pointer effects that degrade to nothing.
 *
 * `trailingSlash: "always"` keeps the URLs the old site had (/work/, /pricing/)
 * so nothing that linked to them breaks.
 */
export default defineConfig({
  site: "https://mortensenweb.com",
  trailingSlash: "always",
  build: { format: "directory", inlineStylesheets: "always" },
  integrations: [
    sitemap({
      // The form's thank-you page is not a page anyone should be sent to.
      filter: (page) => !page.includes("/thanks/"),
    }),
  ],
  // Sharp is a devDependency; images in the work grid are pre-sized files in
  // public/ and served as authored, so the service is only there for the
  // occasional <Image> and the OG image build.
});
