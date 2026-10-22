import type { APIRoute } from "astro";
import { PLANS, OVERAGE_CENTS, dollars, BUILD, FREE_PORTAL, GROWTH_FEATURES, isFree } from "@mortensenweb/plans";
import { SITE, START } from "../data/site";
import { COM_RENEWALS, COM_RENEWAL_RANGE, DOMAIN_PRICES_CHECKED_ON, exactDollars } from "../data/domains";

/** "; plus Review requests (coming soon), …" — the paid tools a plan includes. */
const paidTools = (keys: string[]) => {
  const names = GROWTH_FEATURES.filter((f) => keys.includes(f.key) && !isFree(f)).map((f) =>
    f.available ? f.name : `${f.name} (coming soon)`,
  );
  return names.length ? `; plus ${names.join(", ")}` : "";
};

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
      `- Websites ${dollars(BUILD.priceCents)}, one time; performance tracking (${FREE_PORTAL.features.join(", ").toLowerCase()}) free; plans from ${dollars(Math.min(...PLANS.map((p) => p.monthlyCents)))} a month; no contracts`,
      "",
      "## Key pages",
      `- [Work](${SITE.url}/work/): live client sites, demos and in-house work, each one linked and labelled`,
      `- [Services](${SITE.url}/services/): design and build, hosting and care, changes on request, a leads inbox, Growth tools, and Google, Facebook and Instagram ads (coming soon) — a shop can be built in and connected to Square, Stripe or Shopify, though the store itself is hosted there and not by us; posting to social media is not included`,
      `- [Growth](${SITE.url}/growth/): Growth tools that bring a small business more customers — what each does, which plan includes it, and its price on its own`,
      `- [Pricing](${SITE.url}/pricing/): the build price, then the plans: free performance tracking and four monthly plans`,
      `- [Price guide](${SITE.url}/website-cost/): what a small business website costs in 2026 — the build, the plans, what costs extra, .com domain renewal prices at three registrars, and what to ask any web designer before signing`,
      `- [About](${SITE.url}/about/): ${SITE.founder}, the founder — a mechanical engineering senior at the University of Utah focused on aerospace and defense`,
      `- [Contact](${SITE.url}/contact/): enquiry form and phone; every enquiry is answered, usually the same working day`,
      "",
      "## The build (US dollars, one-time, no plan required)",
      `- ${BUILD.name}: ${dollars(BUILD.priceCents)}. ${BUILD.who} Includes: ${BUILD.includes.join("; ")}.`,
      "- Without a plan, the site is handed over at launch on the client's own hosting account, with no monthly cost.",
      "- A demo of the site is built first; the client pays for the build only once they have seen and approved it.",
      `- Domain registration is not included and stays in the client's name. A .com renews at about ${COM_RENEWAL_RANGE} a year: ${COM_RENEWALS.map((p) => `${p.registrar} ${exactDollars(p.renewalCents)}${p.note ? ` (${p.note})` : ""}`).join(", ")}, checked ${DOMAIN_PRICES_CHECKED_ON}.`,
      "",
      "## How a new site happens",
      ...START.map((s) => `${Number(s.n)}. ${s.title}. ${s.body}`),
      "",
      `## ${FREE_PORTAL.name} (free)`,
      `- ${FREE_PORTAL.description} In the client portal. Includes: ${FREE_PORTAL.features.join("; ")}. With or without a plan.`,
      "",
      "## Plans (monthly, US dollars, no minimum term)",
      ...PLANS.map(
        (p) =>
          `- ${p.name}: ${dollars(p.monthlyCents)}/month, ${p.includedChangesPerMonth ?? "unlimited"} content change${p.includedChangesPerMonth === 1 ? "" : "s"} a month, hosting, SSL and security updates${paidTools(p.growthFeatures)}`,
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
        (f) =>
          `- ${f.name}${f.available ? "" : " (coming soon)"}: ${f.summary} ${isFree(f) ? "Free with every site, with or without a plan." : `Included from the ${PLANS.find((p) => p.key === f.includedFrom)!.name} plan, or ${dollars(f.addOnCents)}/month on its own.`}`,
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
