import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site";

/**
 * Emitted as a static `sitemap.xml` by the export — no request-time work.
 *
 * `/thanks/` is absent on purpose: it is a form redirect target marked
 * noindex, and listing a noindex page in a sitemap asks a crawler to index
 * something the page itself refuses.
 */
export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  const paths = ["/", "/work/", "/services/", "/pricing/", "/contact/"];
  const lastModified = new Date();

  return paths.map((path) => ({
    url: `${SITE.url}${path}`,
    lastModified,
    changeFrequency: path === "/" ? "monthly" : "yearly",
    priority: path === "/" ? 1 : 0.8,
  }));
}
