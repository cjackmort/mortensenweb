import Link from "next/link";

/**
 * Every 404 in the portal: an unknown address, and every `notFound()` — a
 * stale unsubscribe or review link, a shared preview that was revoked, a
 * record that is not yours.
 *
 * It used to be the framework's own white page with "404 | This page could
 * not be found." in a system font. Most people who see it did nothing wrong:
 * they followed an old link from an email. So it says that, on the portal's
 * own ground, and offers the one useful way on. Deliberately the same for
 * every cause — the pages that call `notFound()` do so precisely so that an
 * invalid link and a revoked one cannot be told apart.
 */
export default function NotFound() {
  return (
    <main className="shell" style={{ maxWidth: "36rem" }}>
      <section className="card">
        <h1>This page isn&rsquo;t here</h1>
        <p>The link may be old, or missing a few characters. If someone sent it to you, ask them for a new one.</p>
        <p className="muted">
          Have a portal account? <Link href="/">Go to your portal</Link>.
        </p>
      </section>
    </main>
  );
}
