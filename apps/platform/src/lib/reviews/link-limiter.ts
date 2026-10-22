import { ipFromHeaders } from "@/lib/auth/client-ip";
import { createRateLimiter } from "./rate-limit";

/**
 * The rate limit shared by the public review routes: the tracked link, the
 * unsubscribe page and the one-click unsubscribe.
 *
 * Thirty a minute per address is far above what a customer opening their own
 * email does, and low enough that one client hammering a link stops reaching
 * the database. A request with no address at all is let through: a constant
 * fallback key would put every such visitor in one bucket, and the signed
 * token is the control that holds regardless (see `tokens.ts`).
 */

export const REVIEW_LINK_LIMIT_PER_MINUTE = 30;

const limiter = createRateLimiter({ limit: REVIEW_LINK_LIMIT_PER_MINUTE, windowMs: 60_000 });

export function allowReviewLinkRequest(headers: Headers): boolean {
  const ip = ipFromHeaders(headers);
  return ip ? limiter.allow(ip) : true;
}
