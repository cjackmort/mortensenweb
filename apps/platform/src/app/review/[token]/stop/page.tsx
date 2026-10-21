import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { describeReviewStop } from "@/db/repositories/admin/reviews";
import { allowReviewLinkRequest } from "@/lib/reviews/link-limiter";
import { verifyReviewToken } from "@/lib/reviews/tokens";

/**
 * Where "Unsubscribe" in a review request lands: one question, one button.
 *
 * A button rather than unsubscribing on arrival, because mail scanners open
 * every link in an email; the POST behind the button is the act. The page
 * names only the business — nothing about the customer — since anyone holding
 * the link can open it.
 *
 * Public: the token, signed for `stop`, is checked before the database, then
 * the shared rate limit. Every refusal is a 404.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Unsubscribe",
  robots: { index: false, follow: false, nocache: true },
};

export default async function StopReviewRequestsPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ done?: string }>;
}) {
  if (!allowReviewLinkRequest((await headers()) as unknown as Headers)) notFound();

  const { token } = await params;
  const publicId = await verifyReviewToken(token, "stop");
  if (!publicId) notFound();

  const stop = await describeReviewStop(await getDb(), publicId);
  if (!stop) notFound();
  const done = stop.unsubscribed || (await searchParams).done === "1";

  return (
    <main className="shell" style={{ maxWidth: "36rem" }}>
      <section className="card review-stop">
        {done ? (
          <>
            <h1>You&rsquo;re unsubscribed</h1>
            <p>{stop.businessName} won&rsquo;t send you review requests again.</p>
          </>
        ) : (
          <>
            <h1>Stop review requests?</h1>
            <p>
              {stop.businessName} won&rsquo;t send you any more review requests, by email or by text.
            </p>
            <form method="post" action={`/review/${encodeURIComponent(token)}/unsubscribe`}>
              <button type="submit">Unsubscribe</button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
