import type { NextConfig } from "next";

/**
 * The public agency site.
 *
 * `output: "export"` is the load-bearing choice here. This site has no
 * database, no session, and no per-request anything — it is brochure content
 * plus a Netlify-handled form. Exporting it to plain HTML means the deploy is
 * a folder of static files: no serverless function is invoked, nothing can
 * cold-start, and the `@netlify/plugin-nextjs` adapter is not in the picture
 * at all. That is a smaller surface than the portal needs and deliberately so.
 *
 * The consequence to remember: no server components that fetch at request
 * time, no route handlers, no middleware. If this site ever needs one of
 * those, this line is the decision to revisit — not something to work around
 * with a client-side fetch.
 *
 * `trailingSlash` makes the export emit `about/index.html` rather than
 * `about.html`, which is what lets a plain static host resolve `/about` and
 * `/about/` identically without a redirect rule per page.
 */
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  reactStrictMode: true,

  // The export target has no image optimisation server. Next's default loader
  // would emit `/_next/image?...` URLs that nothing answers, so images are
  // served as authored — already sized for the web before they get here.
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
