import type { Metadata } from "next";
import Link from "next/link";
import { Reveal } from "@/components/Reveal";
import { PLANS } from "@/data/plans";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Care plans from $49/month — hosting, SSL, security updates, and an allowance of content changes. The build itself is quoted per project.",
  alternates: { canonical: "/pricing/" },
};

export default function PricingPage() {
  return (
    <>
      <section className="wrap section section--tight">
        <div className="section-head">
          <p className="eyebrow">Pricing</p>
          <h1>Two numbers: the build, and the month.</h1>
          <p className="lede">
            The build is quoted once, per project, after we understand the
            scope. After launch, one monthly care plan covers hosting, security,
            and an allowance of changes — so keeping the site current is a fixed
            cost rather than a decision every time something needs updating.
          </p>
        </div>

        <div className="plans">
          {PLANS.map((plan, i) => (
            <Reveal key={plan.key} index={i}>
              <div
                className={`plan${plan.featured ? " plan--featured" : ""}`}
              >
                {plan.featured && (
                  <span className="plan__badge">Most chosen</span>
                )}
                <h2 className="plan__name">{plan.name}</h2>
                <div className="plan__price">
                  ${plan.monthly}
                  <span className="plan__cadence">/month</span>
                </div>
                <p className="plan__desc">{plan.description}</p>

                <ul className="plan__features">
                  {plan.features.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>

                <Link
                  className={`btn ${plan.featured ? "btn--primary" : "btn--ghost"}`}
                  href="/contact/"
                >
                  Get started
                </Link>
              </div>
            </Reveal>
          ))}
        </div>

        <p className="muted" style={{ marginTop: "var(--sp-8)" }}>
          Prices in US dollars. Plans are monthly and can be changed or
          cancelled at any time — you own your domain and your content either
          way.
        </p>
      </section>

      {/* ------------------------------------------------------ comparison */}
      <section className="section section--sunk">
        <div className="wrap">
          <Reveal>
            <div className="section-head">
              <p className="eyebrow">Side by side</p>
              <h2>What differs between plans.</h2>
            </div>
          </Reveal>

          <div className="table-scroll">
            <table>
              <caption className="hp">
                Care plan comparison by monthly price, included changes,
                additional change cost, analytics, and turnaround.
              </caption>
              <thead>
                <tr>
                  <th scope="col">&nbsp;</th>
                  {PLANS.map((plan) => (
                    <th scope="col" key={plan.key}>
                      {plan.name.replace("Care — ", "")}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Monthly</th>
                  {PLANS.map((plan) => (
                    <td key={plan.key}>${plan.monthly}</td>
                  ))}
                </tr>
                <tr>
                  <th scope="row">Changes included</th>
                  {PLANS.map((plan) => (
                    <td key={plan.key}>{plan.changesPerMonth} / month</td>
                  ))}
                </tr>
                <tr>
                  <th scope="row">Additional change</th>
                  {PLANS.map((plan) => (
                    <td key={plan.key}>${plan.overage}</td>
                  ))}
                </tr>
                <tr>
                  <th scope="row">Hosting, SSL &amp; updates</th>
                  {PLANS.map((plan) => (
                    <td key={plan.key}>
                      Yes<span className="hp"> — included</span>
                    </td>
                  ))}
                </tr>
                <tr>
                  <th scope="row">Visitor analytics</th>
                  {PLANS.map((plan) => (
                    <td key={plan.key}>{plan.analytics ? "Yes" : "—"}</td>
                  ))}
                </tr>
                <tr>
                  <th scope="row">Priority turnaround</th>
                  {PLANS.map((plan) => (
                    <td key={plan.key}>
                      {plan.key === "care-plus" ? "Yes" : "—"}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- faq */}
      <section className="wrap section">
        <Reveal>
          <div className="section-head">
            <p className="eyebrow">Questions</p>
            <h2>The ones we get asked.</h2>
          </div>
        </Reveal>

        <div className="faq">
          <details>
            <summary>What does the build cost?</summary>
            <p>
              It is quoted per project, because a four-page site for a studio
              and a twenty-page site with a booking flow are not the same job.
              We quote a fixed number before starting — not an hourly rate that
              grows.
            </p>
          </details>
          <details>
            <summary>What counts as one change?</summary>
            <p>
              One request: swapping a set of photos, updating your hours,
              changing prices on a page, adding a paragraph. If a request is
              really a new section or a new page, we will say so before doing
              it and quote it separately rather than quietly using up your
              allowance.
            </p>
          </details>
          <details>
            <summary>Do unused changes roll over?</summary>
            <p>
              No. The allowance resets each month. If you consistently need more
              than your plan includes, moving up a plan costs less than paying
              for additional changes.
            </p>
          </details>
          <details>
            <summary>Who owns the site and the domain?</summary>
            <p>
              You do. The domain is registered in your name, and the content is
              yours. If you leave, we hand over the site files and help you
              point the domain elsewhere.
            </p>
          </details>
          <details>
            <summary>Is there a contract?</summary>
            <p>
              No minimum term on care plans. They are monthly, and you can
              change or cancel at any time.
            </p>
          </details>
          <details>
            <summary>What if the site breaks?</summary>
            <p>
              Fixing something that broke is not a change request and does not
              come out of your allowance. If it is our fault, it is our problem.
            </p>
          </details>
        </div>
      </section>

      <section className="wrap section section--tight">
        <Reveal>
          <div className="cta">
            <h2>Want a number for your project?</h2>
            <p className="lede center">
              Tell us what the site needs to do. We will come back with a
              fixed build quote and the plan that fits.
            </p>
            <div className="btn-row">
              <Link className="btn btn--primary" href="/contact/">
                Request a quote
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
