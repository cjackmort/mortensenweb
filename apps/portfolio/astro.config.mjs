import { defineConfig } from "astro/config";
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
