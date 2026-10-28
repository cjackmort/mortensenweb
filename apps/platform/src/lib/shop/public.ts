/**
 * The shop as a client's website sees it: the feed shape, where a buyer may
 * be sent back to, and the limits on a checkout request. Pure, so the routes
 * and the tests share one reading.
 */

/** Stripe's minimum for a Checkout Session's `expires_at`. */
export const CHECKOUT_EXPIRY_MINUTES = 30;
/** Grace after `expires_at` before the sweep treats a session as abandoned without asking Stripe. */
export const CHECKOUT_SWEEP_GRACE_MINUTES = 5;
/** One piece, or a few prints: a cart is phase 2. */
export const MAX_CHECKOUT_QUANTITY = 10;
/** Where a shop can post to. Every client is in the US; opening this up is a settings change, not a code one. */
export const SHIP_TO_COUNTRIES = ["US"] as const;
/** Where the site's shop page lives, for the return after paying. */
export const SHOP_PAGE_PATH = "/shop";

export const PUBLIC_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface PublicShopProduct {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  priceCents: number;
  /** Units that can be bought right now; null is unlimited. */
  available: number | null;
  /** Image URLs, cover first. */
  images: string[];
}

export interface PublicShop {
  currency: string;
  /** False until Stripe will take the money: the site shows the shop, not the buy button. */
  open: boolean;
  fulfilment: "ship" | "pickup";
  shippingCents: number;
  shippingPolicy: string | null;
  refundPolicy: string | null;
  products: PublicShopProduct[];
}

/**
 * The origins a site is known to serve from, most trusted first. A buyer is
 * only ever sent back to one of these after paying; anything else in a
 * request is ignored, since a page that can name the return address can
 * send a customer who has just paid wherever it likes.
 */
export function siteOrigins(site: {
  primaryDomain: string | null;
  productionUrl: string | null;
  netlifySiteName: string | null;
}): string[] {
  const origins: string[] = [];
  const domain = site.primaryDomain?.trim().toLowerCase();
  if (domain && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    origins.push(`https://${domain}`, `https://www.${domain}`);
  }
  if (site.productionUrl) {
    try {
      const url = new URL(site.productionUrl);
      if (url.protocol === "https:" || url.hostname === "localhost") origins.push(url.origin);
    } catch {
      // Not a URL; nowhere to send anyone.
    }
  }
  const netlify = site.netlifySiteName?.trim().toLowerCase();
  if (netlify && /^[a-z0-9-]+$/.test(netlify)) origins.push(`https://${netlify}.netlify.app`);
  return [...new Set(origins)];
}

/** Where to send the buyer back to: the page they came from if it is the site's own, else the site's shop page. */
export function returnBase(origins: string[], returnTo: unknown): string | null {
  if (origins.length === 0) return null;
  if (typeof returnTo === "string") {
    try {
      const url = new URL(returnTo);
      if (origins.includes(url.origin)) return `${url.origin}${url.pathname}`;
    } catch {
      // Not a URL: fall through to the shop page.
    }
  }
  return `${origins[0]}${SHOP_PAGE_PATH}`;
}

export interface CheckoutRequest {
  productId: string;
  quantity: number;
  returnTo: string | null;
}

/** Read a checkout body without trusting any of it. */
export function parseCheckoutRequest(body: unknown): CheckoutRequest | null {
  if (!body || typeof body !== "object") return null;
  const { productId, quantity, returnTo } = body as Record<string, unknown>;
  if (typeof productId !== "string" || !PUBLIC_ID.test(productId)) return null;
  const qty = quantity === undefined ? 1 : Number(quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_CHECKOUT_QUANTITY) return null;
  return { productId, quantity: qty, returnTo: typeof returnTo === "string" ? returnTo : null };
}

/** `?shop=paid&order=…` and `?shop=cancelled`: what the site's shop page reads on the way back. */
export function checkoutReturnUrls(base: string, orderPublicId: string): { success: string; cancel: string } {
  const join = base.includes("?") ? "&" : "?";
  return {
    success: `${base}${join}shop=paid&order=${orderPublicId}`,
    cancel: `${base}${join}shop=cancelled`,
  };
}
