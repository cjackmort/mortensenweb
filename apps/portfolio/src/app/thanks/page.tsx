import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Thank you",
  description: "Your enquiry has been received.",
  // Nothing links here except a form redirect, and it has no standalone value
  // in results. Keeping it out of the index also keeps it out of the sitemap.
  robots: { index: false, follow: false },
};

export default function ThanksPage() {
  return (
    <section className="wrap section">
      <div className="cta">
        <p className="eyebrow">Received</p>
        <h1>Thanks — that came through.</h1>
        <p className="lede center">
          We read every enquiry and reply personally, usually within one working
          day. If it is urgent, email is the faster route.
        </p>
        <div className="btn-row">
          <Link className="btn btn--ghost" href="/">
            Back to the homepage
          </Link>
          <Link className="btn btn--ghost" href="/work/">
            See the work
          </Link>
        </div>
      </div>
    </section>
  );
}
