import type { APIRoute } from "astro";
import {
  PLANS,
  OVERAGE_CENTS,
  dollars,
  BUILD_PRICE_CENTS,
  BUILD_WITH_CARE_CENTS,
  BUILD_DISCOUNT_CENTS,
  BUILD_COMMITMENT_MONTHS,
} from "@mortensenweb/plans";
import { SITE } from "../data/site";

/** What the site is, for an AI assistant asked about it. Facts only. */
export const GET: APIRoute = () =>
  new Response(
    [
      `# ${SITE.name}`,
      `> ${SITE.description}`,
      "",
      "## Key pages",
      `- [Work](${SITE.url}/work/): live client sites, each one linked`,
      `- [Services](${SITE.url}/services/): design and build, hosting and care, changes on request — and what is not included (online stores, advertising, social media)`,
      `- [Pricing](${SITE.url}/pricing/): both build prices, the care plans and a comparison table`,
      `- [Contact](${SITE.url}/contact/): enquiry form; every enquiry is answered`,
      "",
      "## The build (US dollars)",
      `- ${dollars(BUILD_PRICE_CENTS)} one-time for the site on its own: up to five pages, launched on the client's domain, hosting set up on their own account, no portal and no monthly cost.`,
      `- ${dollars(BUILD_WITH_CARE_CENTS)} one-time when the client starts a care plan with it — ${dollars(BUILD_DISCOUNT_CENTS)} off in exchange for staying on a plan for the first ${BUILD_COMMITMENT_MONTHS} months. Any plan qualifies.`,
      `- Leaving inside those ${BUILD_COMMITMENT_MONTHS} months invoices the unused part of the ${dollars(BUILD_DISCOUNT_CENTS)} pro-rata, and nothing else.`,
      "- The build is invoiced half to start and half at launch. Domain registration is not included and stays in the client's name.",
      "",
      `## Care plans (monthly, US dollars; no minimum term except the first ${BUILD_COMMITMENT_MONTHS} months on the discounted build)`,
      ...PLANS.map(
        (p) =>
          `- ${p.name}: ${dollars(p.monthlyCents)}/month, ${p.includedChangesPerMonth ?? "unlimited"} content change${p.includedChangesPerMonth === 1 ? "" : "s"} a month, hosting, SSL, security updates and visitor analytics included`,
      ),
      `- A change beyond the allowance is ${dollars(OVERAGE_CENTS)} on any plan.`,
      "- A new page, a new section or a redesign is a separate project, quoted on its own.",
      "",
      "## How a change happens",
      "1. The client asks in their portal, in their own words, with photos if useful.",
      "2. The change is made on a copy of the site, checked, and put up at a private preview address — usually within the hour.",
      "3. The client is emailed the preview and a picture of the change, and approves it or asks for changes (which does not use another monthly change).",
      "4. It is published, the live site is checked, and the client is told.",
      "",
      "## Contact",
      `- Email: ${SITE.email}`,
      `- Client portal: ${SITE.portalUrl}`,
      "",
    ].join("\n"),
    { headers: { "content-type": "text/plain; charset=utf-8" } },
  );
