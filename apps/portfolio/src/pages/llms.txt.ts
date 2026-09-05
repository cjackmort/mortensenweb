import type { APIRoute } from "astro";
import { PLANS, OVERAGE_CENTS, dollars } from "@mortensenweb/plans";
import { SITE } from "../data/site";

/** What the site is, for an AI assistant asked about it. Facts only. */
export const GET: APIRoute = () =>
  new Response(
    [
      `# ${SITE.name}`,
      `> ${SITE.description}`,
      "",
      "## Key pages",
      `- [Work](${SITE.url}/work/): sites built, each linked and labelled live or concept`,
      `- [Services](${SITE.url}/services/): design and build, hosting and care, changes on request — and what is not included (online stores, advertising, social media)`,
      `- [Pricing](${SITE.url}/pricing/): the care plans and a comparison table`,
      `- [Contact](${SITE.url}/contact/): enquiry form; every enquiry is answered`,
      "",
      "## Care plans (monthly, no minimum term, US dollars)",
      ...PLANS.map(
        (p) =>
          `- ${p.name}: ${dollars(p.monthlyCents)}/month, ${p.includedChangesPerMonth ?? "unlimited"} content change${p.includedChangesPerMonth === 1 ? "" : "s"} a month, hosting, SSL, security updates and visitor analytics included`,
      ),
      `- A change beyond the allowance is ${dollars(OVERAGE_CENTS)} on any plan.`,
      "- The build itself is quoted per project.",
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
