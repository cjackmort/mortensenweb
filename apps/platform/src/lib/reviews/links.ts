import { signReviewToken } from "./tokens";

/**
 * The three portal URLs a review request carries.
 *
 *  - `reviewLink`: `/review/<click token>` — records the click, then
 *    redirects to the business's Google review form.
 *  - `stopLink`: `/review/<stop token>/stop` — a page with one button, so a
 *    mail scanner opening every link cannot unsubscribe anyone.
 *  - `unsubscribePost`: `/review/<stop token>/unsubscribe` — the one-click
 *    target for `List-Unsubscribe-Post`, which mail providers POST to.
 *
 * Null when the portal cannot mint them — no public URL or no signing secret
 * — and a caller refuses to send rather than send an email whose links lead
 * nowhere.
 */

export interface ReviewLinks {
  reviewLink: string;
  stopLink: string;
  unsubscribePost: string;
}

type Env = Record<string, string | undefined>;

export function portalBaseUrl(env: Env = process.env): string | null {
  const base = (env.AUTH_URL ?? env.NEXT_PUBLIC_SITE_URL)?.trim();
  return base ? base.replace(/\/+$/, "") : null;
}

export async function reviewLinks(publicId: string, env: Env = process.env): Promise<ReviewLinks | null> {
  const base = portalBaseUrl(env);
  const click = await signReviewToken(publicId, "click", env);
  const stop = await signReviewToken(publicId, "stop", env);
  if (!base || !click || !stop) return null;
  return {
    reviewLink: `${base}/review/${click}`,
    stopLink: `${base}/review/${stop}/stop`,
    unsubscribePost: `${base}/review/${stop}/unsubscribe`,
  };
}
