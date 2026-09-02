import Link from "next/link";
import { Reveal, RevealItem } from "@/components/Reveal";
import { DesignIcon, ShieldIcon, EditIcon } from "@/components/icons";
import { PLANS } from "@/data/plans";
import { SITE } from "@/lib/site";

export default function HomePage() {
  const cheapest = PLANS.reduce((low, plan) =>
    plan.monthly < low.monthly ? plan : low,
  );

  return (
    <>
      {/* ------------------------------------------------------------ hero */}
      <section className="section hero">
        <div className="wrap hero__grid">
          <Reveal>
            <p className="eyebrow">Mortensen Web Co.</p>
            <h1 className="hero__title">
              Websites for small businesses, built and looked after.
            </h1>
            <p className="hero__lede">
              Most small businesses do not need a bigger website. They need one
              that loads fast, says the right thing, and does not quietly go
              stale the month after it launches. That is the whole job here —
              design it around what you actually sell, then keep it current.
            </p>

            <div className="btn-row">
              <Link className="btn btn--primary" href="/contact/">
                Start a project
              </Link>
              <Link className="btn btn--ghost" href="/work/">
                See the work
              </Link>
            </div>

            <div className="facts">
              <div>
                <div className="fact__value">Built to load</div>
                <p className="fact__label">
                  Static hosting, real image sizes, no page-builder bloat
                </p>
              </div>
              <div>
                <div className="fact__value">Changes included</div>
                <p className="fact__label">
                  Request them in your portal — no hourly invoice for a typo
                </p>
              </div>
              <div>
                <div className="fact__value">From ${cheapest.monthly}/mo</div>
                <p className="fact__label">
                  Hosting, SSL, and security updates in every plan
                </p>
              </div>
            </div>
          </Reveal>

          <Reveal index={1} className="hero__visual">
            <div className="hero__frame hero__frame--fill" aria-hidden="true" />
          </Reveal>
        </div>
      </section>

      {/* -------------------------------------------------------- services */}
      <section className="section">
        <div className="wrap">
          <Reveal>
            <div className="section-head">
              <p className="eyebrow">What we do</p>
              <h2>Three things, done properly.</h2>
            </div>
          </Reveal>

          <div className="cards">
            <Reveal index={0}>
              <div className="card">
                <DesignIcon />
                <h3>Design and build</h3>
                <p>
                  A site structured around the handful of things a visitor
                  actually came to find — what you make, what it costs, how to
                  reach you. Written and laid out for that, not filled to look
                  busy.
                </p>
              </div>
            </Reveal>
            <Reveal index={1}>
              <div className="card">
                <ShieldIcon />
                <h3>Hosting and care</h3>
                <p>
                  Hosting, SSL, domain configuration, and security updates are
                  part of the plan rather than a separate bill. If something
                  breaks, fixing it is our problem, not a support ticket you
                  have to chase.
                </p>
              </div>
            </Reveal>
            <Reveal index={2}>
              <div className="card">
                <EditIcon />
                <h3>Changes on request</h3>
                <p>
                  New photos, a changed price, a seasonal note at the top of
                  the page. You ask in the portal, we make the change and show
                  you a preview before it goes live.
                </p>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------- process */}
      <section className="section section--sunk">
        <div className="wrap">
          <Reveal>
            <div className="section-head">
              <p className="eyebrow">How it works</p>
              <h2>From first call to live site.</h2>
            </div>
          </Reveal>

          <ol className="steps">
            <RevealItem index={0} className="step">
              <h3>We talk</h3>
              <p>
                A short conversation about the business — who buys from you, what
                you want the site to do, and what is wrong with the one you have
                now.
              </p>
            </RevealItem>
            <RevealItem index={1} className="step">
              <h3>You see a draft</h3>
              <p>
                A working site at a private address, built with your own words
                and photographs. Not a template mockup with placeholder text in
                it.
              </p>
            </RevealItem>
            <RevealItem index={2} className="step">
              <h3>We refine it</h3>
              <p>
                You tell us what is off and we change it. This is the part most
                of the timeline goes into, and it is included.
              </p>
            </RevealItem>
            <RevealItem index={3} className="step">
              <h3>It goes live</h3>
              <p>
                You give us your domain and we tell you exactly what to put in
                your DNS. Once it points here, you get a portal login and
                changes are requested there.
              </p>
            </RevealItem>
          </ol>
        </div>
      </section>

      {/* --------------------------------------------------------- pricing */}
      <section className="section">
        <div className="wrap">
          <Reveal>
            <div className="section-head">
              <p className="eyebrow">Care plans</p>
              <h2>Priced so you can plan for it.</h2>
              <p className="lede">
                The build is quoted per project. After launch, one monthly
                plan covers hosting, security, and an allowance of changes —
                so keeping the site current is a fixed cost rather than a
                decision every time.
              </p>
            </div>
          </Reveal>

          <div className="plans">
            {PLANS.map((plan, i) => (
              <Reveal key={plan.key} index={i}>
                <div
                  className={`plan${plan.featured ? " plan--featured" : ""}`}
                >
                  {plan.featured && (
                    <span className="plan__badge">Most chosen</span>
                  )}
                  <h3 className="plan__name">{plan.name}</h3>
                  <div className="plan__price">
                    ${plan.monthly}
                    <span className="plan__cadence">/month</span>
                  </div>
                  <p className="plan__desc">{plan.description}</p>
                  <Link className="btn btn--ghost" href="/pricing/">
                    Compare plans
                  </Link>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* --------------------------------------------- existing clients */}
      <section className="section section--tight section--sunk">
        <div className="wrap">
          <Reveal>
            <div className="cta">
              <p className="eyebrow">Already a client?</p>
              <h2>Your portal is here.</h2>
              <p className="lede center">
                Request a change, see a preview before it goes live, check
                your visitor numbers, and view invoices. If it is your first
                time signing in, use the username and temporary password from
                your welcome email.
              </p>
              <div className="btn-row">
                <a className="btn btn--primary" href={SITE.portalUrl}>
                  Go to the client portal
                </a>
                <a
                  className="btn btn--ghost"
                  href={`${SITE.portalUrl}/get-started`}
                >
                  First time signing in
                </a>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ------------------------------------------------------------- cta */}
      <section className="section">
        <div className="wrap">
          <Reveal>
            <div className="cta">
              <h2>Let&rsquo;s talk about your site.</h2>
              <p className="lede center">
                Tell us about the business and what you need. We will come
                back with a straight answer about whether we are a good fit
                and what it would cost.
              </p>
              <div className="btn-row">
                <Link className="btn btn--primary" href="/contact/">
                  Start a project
                </Link>
                <a className="btn btn--ghost" href={`mailto:${SITE.email}`}>
                  {SITE.email}
                </a>
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
