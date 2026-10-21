import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { describeUnsubscribe } from "@/db/repositories/admin/winback";
import { verifyUnsubscribeToken } from "@/lib/winback/unsubscribe-token";

/**
 * Where "Unsubscribe" in a win-back email lands: one question, one button.
 *
 * A button rather than unsubscribing on arrival, because mail scanners open
 * every link in an email; the POST behind the button is the act. The page
 * names only the business — nothing about the customer — since anyone holding
 * the link can open it.
 *
 * Public: the token's signature is checked before the database, and every
 * refusal is a 404.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Unsubscribe",
  robots: { index: false, follow: false, nocache: true },
};

export default async function UnsubscribePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ done?: string }>;
}) {
  const { token } = await params;
  const recipient = await verifyUnsubscribeToken(token);
  if (!recipient) notFound();

  const about = await describeUnsubscribe(await getDb(), recipient);
  if (!about) notFound();
  const done = about.done || (await searchParams).done === "1";

  return (
    <main className="shell" style={{ maxWidth: "36rem" }}>
      <section className="card winback-stop">
        {done ? (
          <>
            <h1>You&rsquo;re unsubscribed</h1>
            <p>{about.businessName} won&rsquo;t send you offers or reminders by email again.</p>
          </>
        ) : (
          <>
            <h1>Stop emails from {about.businessName}?</h1>
            <p>You won&rsquo;t get any more offers or seasonal reminders from them by email.</p>
            <form method="post" action={`/api/unsubscribe/${encodeURIComponent(token)}`}>
              <button type="submit">Unsubscribe</button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
