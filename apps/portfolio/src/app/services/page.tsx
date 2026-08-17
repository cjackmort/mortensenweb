import type { Metadata } from "next";
import Link from "next/link";
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
          <div className="card">
            <h3>Design and build</h3>
            <p>
              A custom site, structured around what a visitor actually came to
              find. Written with you, using your photographs — or we will tell
              you honestly when the photography is the thing holding the site
              back.
            </p>
          </div>
          <div className="card">
            <h3>Mobile first, genuinely</h3>
            <p>
              Most visitors arrive on a phone. Every layout is built at the
              narrow width first and given more structure as the screen grows,
              rather than a desktop design left to reflow.
            </p>
          </div>
          <div className="card">
            <h3>Hosting and security</h3>
            <p>
              Hosting, SSL certificates, domain and DNS configuration, and
              ongoing dependency updates. Included in every care plan rather
              than billed separately.
            </p>
          </div>
          <div className="card">
            <h3>Content changes</h3>
            <p>
              Request a change in the portal and we make it. You see a preview
              of the change before it goes live, and nothing publishes until you
              approve it.
            </p>
          </div>
          <div className="card">
            <h3>Analytics without the creep</h3>
            <p>
              Visitor numbers, popular pages, and where people came from — using
              privacy-respecting analytics rather than an ad network. Included
              on Basic and Plus.
            </p>
          </div>
          <div className="card">
            <h3>Search basics</h3>
            <p>
              Clean markup, real page titles and descriptions, fast loads, and a
              sitemap. The groundwork that lets you be found — not a monthly SEO
              retainer.
            </p>
          </div>
        </div>
      </section>

      <section className="section section--sunk">
        <div className="wrap">
          <div className="section-head">
            <p className="eyebrow">Scope</p>
            <h2>What we do not do.</h2>
            <p className="lede">
              These are not failures of the plan — they are outside it, and
              pretending otherwise would just mean a bad version of each.
            </p>
          </div>

          <div className="cards">
            <div className="card">
              <h3>Online stores</h3>
              <p>
                Inventory, payments, tax, and shipping are a different kind of
                project. If you need to sell online, we will say so and point
                you at the right platform.
              </p>
            </div>
            <div className="card">
              <h3>Paid advertising</h3>
              <p>
                We do not run ad campaigns or manage ad spend. The site is built
                so that traffic you send to it converts; getting the traffic is
                someone else&rsquo;s speciality.
              </p>
            </div>
            <div className="card">
              <h3>Social media management</h3>
              <p>
                We will link your accounts and match the site to how you already
                present yourself. We will not post on your behalf.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="wrap section section--tight">
        <div className="cta">
          <h2>Not sure which of these you need?</h2>
          <p className="lede center">
            Describe the business and the problem. We will tell you what would
            actually help, including when the answer is that your current site
            is fine.
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
      </section>
    </>
  );
}
