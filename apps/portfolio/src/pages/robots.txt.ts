import type { APIRoute } from "astro";
import { SITE } from "../data/site";

/**
 * Allow everyone, including the AI answer engines by name — being cited by
 * them is the point. `llms.txt` is the plain-language summary they read.
 */
export const GET: APIRoute = () =>
  new Response(
    [
      "User-agent: *",
      "Allow: /",
      "Disallow: /thanks/",
      "",
      "User-agent: GPTBot",
      "User-agent: OAI-SearchBot",
      "User-agent: ClaudeBot",
      "User-agent: Claude-SearchBot",
      "User-agent: PerplexityBot",
      "User-agent: Google-Extended",
      "Allow: /",
      "",
      `Sitemap: ${SITE.url}/sitemap-index.xml`,
      `# Summary for language models: ${SITE.url}/llms.txt`,
      "",
    ].join("\n"),
    { headers: { "content-type": "text/plain; charset=utf-8" } },
  );
