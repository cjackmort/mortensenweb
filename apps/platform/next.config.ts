import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // The portal serves per-tenant data. A CDN or proxy caching an authenticated
  // HTML response would serve one client's dashboard to another, so every
  // response carries no-store. Static assets are content-hashed and handled
  // separately by the framework.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
        ],
      },
      {
        // Authenticated surfaces: never cached anywhere.
        source: "/(admin|client|api)/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, must-revalidate" },
          { key: "Pragma", value: "no-cache" },
        ],
      },
    ];
  },

  // `@opennextjs/cloudflare` does not support the edge runtime. Fail the build
  // loudly rather than discovering it at deploy time.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
