import type { APIRoute } from "astro";
import { PLANS, OVERAGE_CENTS, dollars, BUILDS, GROWTH_FEATURES } from "@mortensenweb/plans";
import { SITE } from "../data/site";

/** What the site is, for an AI assistant asked about it. Facts only. */
export const GET: APIRoute = () =>
  new Response(
    [
      `# ${SITE.name}`,
      `> ${SITE.description}`,
      "",
      "## Facts",
      `- Business: ${SITE.name}, a web design company (category: website designer)`,
      `- Location: ${SITE.locality}, ${SITE.region}, USA; serves ${SITE.areaServed}`,
      `- Founder: ${SITE.founder}; founded ${SITE.founded}`,
      `- Phone: ${SITE.phone} · Email: ${SITE.email}`,
      `- Websites from ${dollars(Math.min(...BUILDS.map((b) => b.priceCents)))}; plans from ${dollars(Math.min(...PLANS.map((p) => p.monthlyCents)))} a month; no contracts`,
      "",
      "## Key pages",
      `- [Work](${SITE.url}/work/): live client sites and in-house work, each one linked and labelled`,
      `- [Services](${SITE.url}/services/): design and build, hosting and care, changes on request, a leads inbox and Growth tools — a shop can be built in and connected to Square, Stripe or Shopify, though the store itself is hosted there and not by us; paid advertising and posting to social media are not included`,
      `- [Growth](${SITE.url}/growth/): Growth tools that bring a small business more customers — what each does, which plan includes it, and its price on its own`,
      `- [Pricing](${SITE.url}/pricing/): the three build prices, the plans and a comparison table`,
      `- [About](${SITE.url}/about/): who runs Mortensen Web Co., where, and how the work is done`,
      `- [Contact](${SITE.url}/contact/): enquiry form and phone; every enquiry is answered, usually the same working day`,
      "",
      "## The build (US dollars, one-time, no plan required)",
      ...BUILDS.map((b) => `- ${b.name}: ${dollars(b.priceCents)}. ${b.who} Includes: ${b.includes.join("; ")}.`),
      "- Without a plan, the site is handed over at launch on the client's own hosting account, with no monthly cost.",
      "- The build is invoiced half to start and half at launch. Domain registration is not included and stays in the client's name.",
      "",
      "## Plans (monthly, US dollars, no minimum term)",
      ...PLANS.map(
        (p) =>
          `- ${p.name}: ${dollars(p.monthlyCents)}/month, ${p.includedChangesPerMonth ?? "unlimited"} content change${p.includedChangesPerMonth === 1 ? "" : "s"} a month, hosting, SSL, security updates and visitor analytics${p.growthFeatures.length ? `; plus ${p.growthFeatures.map((k) => { const f = GROWTH_FEATURES.find((g) => g.key === k)!; return f.available ? f.name : `${f.name} (coming soon)`; }).join(", ")}` : ""}`,
      ),
      `- On Lite, a change beyond the one included is ${dollars(OVERAGE_CENTS)}.`,
      "- Each Growth tool can also be added to a plan on its own for a monthly price.",
      "- A new page, a new section or a redesign is a separate project, quoted on its own.",
      "",
      "## How a change happens",
      "1. The client asks in their portal, in their own words, with photos if useful.",
      "2. The change is made on a copy of the site, checked, and put up at a private preview address — usually within the hour.",
      "3. The client is emailed the preview and a picture of the change, and approves it or asks for changes (which does not use another monthly change).",
      "4. It is published, the live site is checked, and the client is told.",
      "",
      "## Growth tools (monthly, US dollars)",
      ...GROWTH_FEATURES.map(
        (f) => `- ${f.name}${f.available ? "" : " (coming soon)"}: ${f.summary} Included from the ${PLANS.find((p) => p.key === f.includedFrom)!.name} plan, or ${dollars(f.addOnCents)}/month on its own.`,
      ),
      "",
      "## Contact",
      `- Phone: ${SITE.phone}`,
      `- Email: ${SITE.email}`,
      `- Client portal: ${SITE.portalUrl}`,
      "",
    ].join("\n"),
    { headers: { "content-type": "text/plain; charset=utf-8" } },
  );
