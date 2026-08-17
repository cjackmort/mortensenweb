import Link from "next/link";
import { SITE } from "@/lib/site";

export default function NotFound() {
  return (
    <section className="wrap section">
      <div className="cta">
        <p className="eyebrow">404</p>
        <h1>That page isn&rsquo;t here.</h1>
        <p className="lede center">
          The link may be out of date, or the address slightly off. If you were
          heading for your client portal, it lives on a separate address.
        </p>
        <div className="btn-row">
          <Link className="btn btn--primary" href="/">
            Back to the homepage
          </Link>
          <a className="btn btn--ghost" href={SITE.portalUrl}>
            Client portal
          </a>
        </div>
      </div>
    </section>
  );
}
