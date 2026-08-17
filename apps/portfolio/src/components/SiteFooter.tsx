import Link from "next/link";
import { SITE } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="footer">
      <div className="wrap">
        <div className="footer__grid">
          <div>
            <Link href="/" className="brand">
              Mortensen<span className="brand__mark">Web</span>
            </Link>
            <p className="footer__blurb">{SITE.tagline}</p>
          </div>

          <div>
            <h4>Company</h4>
            <ul>
              <li>
                <Link href="/work/">Work</Link>
              </li>
              <li>
                <Link href="/services/">Services</Link>
              </li>
              <li>
                <Link href="/pricing/">Pricing</Link>
              </li>
              <li>
                <Link href="/contact/">Contact</Link>
              </li>
            </ul>
          </div>

          <div>
            <h4>Clients</h4>
            <ul>
              <li>
                <a href={SITE.portalUrl}>Client portal</a>
              </li>
              <li>
                <a href={`${SITE.portalUrl}/get-started`}>First-time sign in</a>
              </li>
              <li>
                <a href={`${SITE.portalUrl}/forgot-password`}>
                  Forgotten password
                </a>
              </li>
            </ul>
          </div>

          <div>
            <h4>Contact</h4>
            <ul>
              <li>
                <a href={`mailto:${SITE.email}`}>{SITE.email}</a>
              </li>
              <li>
                <Link href="/contact/">Start a project</Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="footer__base">
          <span>
            &copy; {new Date().getFullYear()} {SITE.name}
          </span>
          <span>Built and hosted in-house.</span>
        </div>
      </div>
    </footer>
  );
}
