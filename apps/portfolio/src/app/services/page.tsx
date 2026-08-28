import type { Metadata } from "next";
import Link from "next/link";
import { Reveal } from "@/components/Reveal";
import {
  DesignIcon,
  PhoneIcon,
  ShieldIcon,
  EditIcon,
  ChartIcon,
  SearchIcon,
} from "@/components/icons";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: "Services",
  description:
    "Design and build, hosting and care, and changes on request — what Mortensen Web Co. does for a small business website, and what is included.",
  alternates: { canonical: "/services/" },
};

export default function ServicesPage() {
  return (
    <>
      <section className="wrap section section--tight">
        <div className="section-head">
          <p className="eyebrow">Services</p>
          <h1>What you get, and what it does not include.</h1>
          <p className="lede">
            Being specific about the second part saves everyone a difficult
            conversation later.
          </p>
        </div>

        <div className="cards">
          {[
            {
              title: "Design and build",
              body: "A custom site, structured around what a visitor actually came to find. Written with you, using your photographs — or we will tell you honestly when the photography is the thing holding the site back.",
              Icon: DesignIcon,
            },
            {
              title: "Mobile first, genuinely",
              body: "Most visitors arrive on a phone. Every layout is built at the narrow width first and given more structure as the screen grows, rather than a desktop design left to reflow.",
              Icon: PhoneIcon,
            },
            {
              title: "Hosting and security",
              body: "Hosting, SSL certificates, domain and DNS configuration, and ongoing dependency updates. Included in every care plan rather than billed separately.",
              Icon: ShieldIcon,
            },
            {
              title: "Content changes",
              body: "Request a change in the portal and we make it. You see a preview of the change before it goes live, and nothing publishes until you approve it.",
              Icon: EditIcon,
            },
            {
              title: "Analytics without the creep",
              body: "Visitor numbers, popular pages, and where people came from — using privacy-respecting analytics rather than an ad network. Included on Basic and Plus.",
              Icon: ChartIcon,
            },
            {
              title: "Search basics",
              body: "Clean markup, real page titles and descriptions, fast loads, and a sitemap. The groundwork that lets you be found — not a monthly SEO retainer.",
              Icon: SearchIcon,
            },
          ].map(({ title, body, Icon }, i) => (
            <Reveal key={title} index={i}>
              <div className="card">
                <Icon />
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="section section--sunk">
        <div className="wrap">
          <Reveal>
            <div className="section-head">
              <p className="eyebrow">Scope</p>
              <h2>What we do not do.</h2>
              <p className="lede">
                These are not failures of the plan — they are outside it, and
                pretending otherwise would just mean a bad version of each.
              </p>
            </div>
          </Reveal>

          <div className="cards">
            {[
              {
                title: "Online stores",
                body: "Inventory, payments, tax, and shipping are a different kind of project. If you need to sell online, we will say so and point you at the right platform.",
              },
              {
                title: "Paid advertising",
                body: "We do not run ad campaigns or manage ad spend. The site is built so that traffic you send to it converts; getting the traffic is someone else’s speciality.",
              },
              {
                title: "Social media management",
                body: "We will link your accounts and match the site to how you already present yourself. We will not post on your behalf.",
              },
            ].map((item, i) => (
              <Reveal key={item.title} index={i}>
                <div className="card">
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="wrap section section--tight">
        <Reveal>
          <div className="cta">
            <h2>Not sure which of these you need?</h2>
            <p className="lede center">
              Describe the business and the problem. We will tell you what
              would actually help, including when the answer is that your
              current site is fine.
            </p>
            <div className="btn-row">
              <Link className="btn btn--primary" href="/contact/">
                Get in touch
              </Link>
              <a className="btn btn--ghost" href={`mailto:${SITE.email}`}>
                {SITE.email}
              </a>
            </div>
          </div>
        </Reveal>
      </section>
    </>
  );
}
