import { isIP } from "node:net";

/**
 * Deciding whether a URL is safe to fetch.
 *
 * The crawler takes a URL an operator typed and fetches it from inside our
 * infrastructure, which is the textbook server-side request forgery shape: the
 * value is attacker-influenced (a prospect's site, or a URL someone talked the
 * operator into pasting) and the request carries our network position.
 *
 * Stage 0 §13.1 lists the controls. They are implemented as pure functions here
 * so the interesting half — which addresses are refused — is testable without a
 * network, and so the fetch layer has nothing to decide for itself.
 *
 * Everything is a refusal. A hostname that cannot be resolved, an address
 * family that is not recognised, a scheme that is not https: all rejected. An
 * unanticipated input must fail closed, because the cost of being wrong here is
 * reading something on a private network that nobody meant to expose.
 */

export type UrlRefusal =
  | "not_a_url"
  | "scheme"
  | "credentials"
  | "port"
  | "private_address";

export interface UrlVerdict {
  ok: boolean;
  reason?: UrlRefusal;
  detail?: string;
}

const ALLOWED_PORTS = new Set(["", "443"]);

/**
 * Checks that need no DNS: shape, scheme, credentials, port.
 *
 * Split from the address check because this half runs on every redirect hop and
 * on user input before any lookup is spent, and because it is the half that can
 * be exercised in a test without stubbing a resolver.
 */
export function inspectUrl(raw: string): UrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not_a_url", detail: "Not a URL." };
  }

  // https only. http would be silently downgraded content on a network we do
  // not control, and it is also the easy path to an internal service that never
  // bothered with TLS.
  if (url.protocol !== "https:") {
    return { ok: false, reason: "scheme", detail: `Only https is allowed (got ${url.protocol}).` };
  }

  // `https://user:pass@host` — credentials in a URL are never something we
  // should be replaying, and some parsers disagree about where the host ends,
  // which is its own class of bypass.
  if (url.username || url.password) {
    return { ok: false, reason: "credentials", detail: "URLs with credentials are refused." };
  }

  if (!ALLOWED_PORTS.has(url.port)) {
    return { ok: false, reason: "port", detail: `Port ${url.port} is not allowed.` };
  }

  return { ok: true };
}

/**
 * Is this a literal address we must never connect to?
 *
 * Covers the ranges named in §13.1 plus the ones that bite in practice:
 * IPv4-mapped IPv6 (`::ffff:169.254.169.254` reaches the metadata service on a
 * stack that accepts it), and the unspecified addresses, which route to
 * localhost on most systems.
 */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true; // Not an address we can reason about.

  if (family === 4) return isBlockedIpv4(address);
  return isBlockedIpv6(address);
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];

  if (a === 0) return true; // 0.0.0.0/8 — "this network", routes to local.
  if (a === 10) return true; // Private.
  if (a === 127) return true; // Loopback.
  if (a === 169 && b === 254) return true; // Link-local, and cloud metadata.
  if (a === 172 && b >= 16 && b <= 31) return true; // Private.
  if (a === 192 && b === 168) return true; // Private.
  if (a === 100 && b >= 64 && b <= 127) return true; // Carrier-grade NAT.
  if (a >= 224) return true; // Multicast and reserved.

  return false;
}

function isBlockedIpv6(address: string): boolean {
  const lower = address.toLowerCase();

  if (lower === "::" || lower === "::1") return true; // Unspecified, loopback.

  // An IPv4 address wearing an IPv6 hat. Without this, ::ffff:169.254.169.254
  // reaches the metadata endpoint on any stack that unwraps it.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mapped?.[1]) return isBlockedIpv4(mapped[1]);

  // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast.
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(lower)) return true;
  if (lower.startsWith("ff")) return true;

  return false;
}

/**
 * Every address a hostname resolves to must be public.
 *
 * All of them, not the first: a name that returns one public and one private
 * address would otherwise be a coin flip, and the attacker picks the ordering.
 */
export function areAllAddressesPublic(addresses: string[]): boolean {
  if (addresses.length === 0) return false;
  return addresses.every((address) => !isBlockedAddress(address));
}
