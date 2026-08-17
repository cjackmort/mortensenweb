import type { Metadata } from "next";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: "Contact",
  description:
    "Tell us about your business and what you need from a website. We reply to every enquiry.",
  alternates: { canonical: "/contact/" },
};

/**
 * Netlify Forms, not a route handler.
 *
 * This site is a static export, so there is no server to post to. Netlify's
 * build step scans the emitted HTML for `data-netlify="true"` and stands up an
 * endpoint for it, which is why the form has to exist in the exported markup —
 * a form built by JavaScript after hydration is invisible to that scan and
 * silently never receives submissions.
 *
 * Three details are load-bearing and easy to lose in a tidy-up:
 *
 *   - `name` on the form, and the matching hidden `form-name` input. The
 *     hidden input is what identifies the submission on POST; without it every
 *     submission 404s even though the form was detected at build time.
 *   - `action` is the post-submit redirect. It must be a real exported page,
 *     hence `/thanks/` with the trailing slash this export uses.
 *   - `netlify-honeypot` names a field a human never fills. It is positioned
 *     off-screen rather than `display:none`, and marked `aria-hidden` with
 *     `tabindex="-1"` so assistive tech skips it too.
 */
export default function ContactPage() {
  return (
    <>
      <section className="wrap section section--tight">
        <div className="section-head">
          <p className="eyebrow">Contact</p>
          <h1>Tell us about the business.</h1>
          <p className="lede">
            The more concrete you are about what is wrong with the current site
            — or what the new one has to do — the more useful our first reply
            will be. Every enquiry gets an answer, including the ones where we
            are not the right fit.
          </p>
        </div>

        <form
          className="form"
          name="contact"
          method="POST"
          action="/thanks/"
          data-netlify="true"
          netlify-honeypot="company-website"
        >
          <input type="hidden" name="form-name" value="contact" />

          <p className="hp" aria-hidden="true">
            <label>
              Leave this field empty
              <input name="company-website" tabIndex={-1} autoComplete="off" />
            </label>
          </p>

          <div className="field">
            <label htmlFor="name">Your name</label>
            <input id="name" name="name" type="text" autoComplete="name" required />
          </div>

          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
            />
          </div>

          <div className="field">
            <label htmlFor="business">Business name</label>
            <input
              id="business"
              name="business"
              type="text"
              autoComplete="organization"
            />
          </div>

          <div className="field">
            <label htmlFor="current-site">Current website</label>
            <input
              id="current-site"
              name="current-site"
              type="text"
              inputMode="url"
              placeholder="example.com — or leave blank if there isn't one"
            />
            <span className="field__hint">
              If you have one, we will look at it before replying.
            </span>
          </div>

          <div className="field">
            <label htmlFor="budget">Rough budget for the build</label>
            <select id="budget" name="budget" defaultValue="">
              <option value="">Not sure yet</option>
              <option value="under-1500">Under $1,500</option>
              <option value="1500-3000">$1,500 – $3,000</option>
              <option value="3000-6000">$3,000 – $6,000</option>
              <option value="over-6000">Over $6,000</option>
            </select>
            <span className="field__hint">
              A range is fine. It tells us what is realistic to propose.
            </span>
          </div>

          <div className="field">
            <label htmlFor="message">What do you need?</label>
            <textarea id="message" name="message" required />
          </div>

          <button className="btn btn--primary" type="submit">
            Send enquiry
          </button>

          <p className="field__hint">
            Prefer email? <a href={`mailto:${SITE.email}`}>{SITE.email}</a>
          </p>
        </form>
      </section>

      <section className="wrap section section--tight">
        <div className="cta">
          <p className="eyebrow">Already a client?</p>
          <h2>Change requests go through the portal.</h2>
          <p className="lede center">
            It keeps your requests, previews, and invoices in one place — and
            means nothing gets lost in an inbox.
          </p>
          <div className="btn-row">
            <a className="btn btn--primary" href={SITE.portalUrl}>
              Go to the client portal
            </a>
          </div>
        </div>
      </section>
    </>
  );
}
