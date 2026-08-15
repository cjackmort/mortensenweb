/**
 * Issued credentials: sign-in handles and temporary passwords.
 *
 * These are read aloud over the phone and typed on a phone keyboard by someone
 * standing next to a furnace. Legibility is a real requirement, not a nicety —
 * a credential that gets mistyped three times locks the account and generates a
 * support call.
 */

/**
 * Words chosen to be short, common, unambiguous when spoken, and free of
 * homophones ("their/there") or letters that blur on a phone screen. Expand
 * these lists freely; entropy scales with their size.
 */
const ADJECTIVES = [
  "amber", "anchor", "autumn", "basin", "brave", "brick", "bright", "bronze",
  "calm", "cedar", "clear", "clever", "copper", "coral", "crisp", "dawn",
  "eager", "early", "east", "ember", "fair", "falcon", "flint", "fresh",
  "garnet", "gentle", "golden", "granite", "harbor", "hazel", "honest", "ivory",
  "jade", "keen", "level", "lively", "maple", "marble", "meadow", "north",
  "olive", "opal", "pine", "plain", "polar", "prairie", "quartz", "quiet",
  "rapid", "ridge", "river", "rustic", "sage", "sandy", "silver", "solid",
  "spruce", "steady", "stone", "summit", "sunny", "swift", "timber", "true",
];

const NOUNS = [
  "acorn", "anvil", "arbor", "badger", "beacon", "birch", "bison", "bridge",
  "canyon", "cabin", "cedar", "cobalt", "compass", "cove", "crane", "delta",
  "denim", "eagle", "elm", "falcon", "fern", "forge", "fox", "glacier",
  "harbor", "hawk", "heron", "hickory", "island", "juniper", "kestrel", "lake",
  "lantern", "ledger", "maple", "marlin", "meadow", "mesa", "moose", "orchard",
  "otter", "pelican", "pillar", "pines", "quarry", "raven", "ridge", "river",
  "salmon", "sparrow", "spruce", "stream", "sumac", "summit", "thistle", "timber",
  "trail", "tundra", "valley", "walnut", "willow", "wolf", "wren", "yarrow",
];

/** Cryptographically uniform index, rejecting modulo bias. */
function randomIndex(upperBound: number): number {
  const limit = Math.floor(0xffffffff / upperBound) * upperBound;
  const buf = new Uint32Array(1);
  let value: number;
  do {
    crypto.getRandomValues(buf);
    value = buf[0]!;
  } while (value >= limit);
  return value % upperBound;
}

/**
 * A temporary password, e.g. `granite-kestrel-418302`.
 *
 * Roughly 32 bits of entropy. That is deliberately modest, because this
 * credential's security does not rest on entropy alone: it is single-use, it
 * expires (default 7 days), the account locks after 5 failed attempts in 15
 * minutes, and it is void the moment the client sets their own password. A
 * 20-character random string would be marginally stronger and would be
 * mistyped, written on a sticky note, or phoned in wrong — a worse outcome.
 */
export function generateTemporaryPassword(): string {
  const adjective = ADJECTIVES[randomIndex(ADJECTIVES.length)]!;
  const noun = NOUNS[randomIndex(NOUNS.length)]!;
  const digits = String(randomIndex(1_000_000)).padStart(6, "0");
  return `${adjective}-${noun}-${digits}`;
}

/** Reserved handles that must never be issued to a client. */
const RESERVED_USERNAMES = new Set([
  "admin", "administrator", "root", "support", "help", "billing", "security",
  "api", "www", "mail", "postmaster", "webmaster", "owner", "system", "staff",
  "mortensen", "mortensenweb", "test", "demo", "null", "undefined",
]);

/**
 * Turn a business name into a sign-in handle: "Northwind Comfort Systems"
 * becomes `northwind-comfort`.
 *
 * Two words keeps it short enough to say once. Uniqueness is not guaranteed
 * here — the caller resolves collisions against the database.
 */
export function suggestUsername(businessName: string): string {
  const words = businessName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean)
    // Drop entity suffixes and filler that carry no identifying value.
    .filter(
      (w) =>
        ![
          "llc", "inc", "co", "corp", "company", "the", "and", "of", "ltd",
          "services", "service", "group", "solutions",
        ].includes(w),
    );

  const base = words.slice(0, 2).join("-") || "client";
  return base.slice(0, 32).replace(/-+$/, "");
}

export function isReservedUsername(candidate: string): boolean {
  return RESERVED_USERNAMES.has(candidate.toLowerCase());
}

const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

export function isValidUsername(candidate: string): boolean {
  return USERNAME_PATTERN.test(candidate) && !isReservedUsername(candidate);
}

/**
 * Resolve a unique handle by appending a numeric suffix on collision:
 * `northwind-comfort`, then `northwind-comfort-2`, and so on.
 *
 * `isTaken` is injected so this stays pure and testable.
 */
export async function resolveUniqueUsername(
  businessName: string,
  isTaken: (candidate: string) => Promise<boolean>,
): Promise<string> {
  const base = suggestUsername(businessName);
  let candidate = base;

  for (let suffix = 2; suffix < 100; suffix += 1) {
    if (!isReservedUsername(candidate) && !(await isTaken(candidate))) {
      return candidate;
    }
    candidate = `${base}-${suffix}`;
  }

  // Pathological fallback: a random discriminator rather than an infinite loop.
  return `${base}-${String(randomIndex(100_000)).padStart(5, "0")}`;
}

/** Default lifetime of an issued temporary password. */
export const TEMP_PASSWORD_TTL_DAYS = 7;

export function temporaryPasswordExpiry(
  from: Date = new Date(),
  days: number = TEMP_PASSWORD_TTL_DAYS,
): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}
