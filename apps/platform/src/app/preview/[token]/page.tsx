import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { resolveShareToken } from "@/db/repositories/admin/shares";

/**
 * The one page a prospect reaches without an account.
 *
 * They were sent a link by the operator; this resolves it and shows them their
 * concept. Four things about it are deliberate.
 *
 * **Every refusal is a 404.** Expired, revoked, mistyped, never existed — all
 * the same response. Distinguishing them would confirm which tokens were once
 * real, and this is an unauthenticated endpoint anyone can hammer.
 *
 * **`noindex`, unconditionally.** A concept is a speculative mock-up of a
 * business that has agreed to nothing. Search engines finding it would be a
 * real harm to a real company, and the meta tag is set here rather than
 * inherited so no future layout change can quietly remove it.
 *
 * **The token is in the path, not a query string.** Query strings end up in
 * referrer headers and analytics; a path segment does too, but the page carries
 * no third-party scripts and links out with `noreferrer`.
 *
 * **The preview itself is an outbound link, not an iframe.** Framing it would
 * put our origin around content an agent generated, which is both a wider
 * attack surface and a worse experience on a phone.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default async function SharedPreviewPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const db = await getDb();

  const share = await resolveShareToken(db, token);
  if (!share) notFound();

  return (
    <main className="shell" style={{ maxWidth: "42rem" }}>
      <div className="masthead">
        <h1>A concept for {share.businessName}</h1>
      </div>

      <section className="card">
        <p style={{ marginTop: 0 }}>
          We put together an idea of what a new website for{" "}
          {share.businessName} could look like. Nothing here is live, and
          nothing about your current website has been touched.
        </p>

        <p>
          <a
            className="button"
            href={share.previewUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Look at the concept
          </a>
        </p>

        <p className="field-hint" style={{ marginBottom: 0 }}>
          This link expires. If it stops working and you&rsquo;d still like to
          see it, just ask us for a new one.
        </p>
      </section>

      <section className="card">
        <h2>What happens next</h2>
        <p style={{ marginBottom: 0 }}>
          If you like the direction, we&rsquo;ll talk through what you&rsquo;d
          change, adjust it, and only then discuss going live. Your existing
          site keeps running the whole time — nothing changes until you say so.
        </p>
      </section>
    </main>
  );
}
