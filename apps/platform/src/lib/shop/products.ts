import { SHOP_MIN_PRICE_CENTS } from "@/db/schema/shop";
import { money, parseDollars } from "./money";

/**
 * What a product is before it touches the database: the limits, the slug,
 * and the reading of what a client typed.
 */

/** Enough to show a piece from every side; more is a gallery. */
export const MAX_PRODUCT_PHOTOS = 6;
export const MAX_PRODUCT_NAME_CHARS = 120;
export const MAX_PRODUCT_DESCRIPTION_CHARS = 2000;
/** $100,000. Above this somebody typed cents into the dollars field. */
export const MAX_PRICE_CENTS = 10_000_000;
export const MAX_STOCK = 100_000;

export interface ProductFields {
  name: string;
  description: string | null;
  priceCents: number;
  /** Null is unlimited. */
  stock: number | null;
}

export type ProductInputCheck = { ok: true; fields: ProductFields } | { ok: false; message: string };

/**
 * Stock as typed. Blank means "do not count": a print run that can always
 * be made again. A number is units on hand.
 */
export function parseStock(input: string): { ok: true; stock: number | null } | { ok: false } {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: true, stock: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  const stock = Number(trimmed);
  if (stock > MAX_STOCK) return { ok: false };
  return { ok: true, stock };
}

export function validateProductInput(input: {
  name: string;
  description: string;
  price: string;
  stock: string;
}): ProductInputCheck {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length === 0) return { ok: false, message: "Give the product a name." };
  if (name.length > MAX_PRODUCT_NAME_CHARS) {
    return { ok: false, message: `Keep the name under ${MAX_PRODUCT_NAME_CHARS} characters.` };
  }

  const description = input.description.replace(/\r\n/g, "\n").trim() || null;
  if ((description?.length ?? 0) > MAX_PRODUCT_DESCRIPTION_CHARS) {
    return { ok: false, message: `Keep the description under ${MAX_PRODUCT_DESCRIPTION_CHARS.toLocaleString()} characters.` };
  }

  const priceCents = parseDollars(input.price);
  if (priceCents === null) return { ok: false, message: "Enter the price in dollars, like 150 or 24.50." };
  if (priceCents < SHOP_MIN_PRICE_CENTS) {
    return { ok: false, message: `The price must be at least ${money(SHOP_MIN_PRICE_CENTS)}: cards cannot be charged less.` };
  }
  if (priceCents > MAX_PRICE_CENTS) {
    return { ok: false, message: `That price is over ${money(MAX_PRICE_CENTS)}. Check it is in dollars, not cents.` };
  }

  const stock = parseStock(input.stock);
  if (!stock.ok) {
    return { ok: false, message: `Stock is a whole number of units up to ${MAX_STOCK.toLocaleString()}, or blank for unlimited.` };
  }

  return { ok: true, fields: { name, description, priceCents, stock: stock.stock } };
}

/**
 * The product's path on the site, from its name: "Small Cast Fish (2024)"
 * becomes "small-cast-fish-2024". A name with nothing usable in it becomes
 * "product", and the caller makes it unique.
 */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
  return slug || "product";
}

/** The first of `base`, `base-2`, `base-3`… not in `taken`. */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** What the client sees under a product: units they can still sell, and units held by open checkouts. */
export function stockLabel(stock: number | null, reserved: number): string {
  if (stock === null) return "Unlimited";
  const available = Math.max(0, stock - reserved);
  const units = available === 1 ? "unit" : "units";
  if (reserved === 0) return available === 0 ? "Sold out" : `${available} ${units} left`;
  return `${available} ${units} left, ${reserved} held in open checkouts`;
}

const FIELD_WORDS: Record<string, string> = {
  name: "name",
  description: "description",
  priceCents: "price",
  stock: "stock",
  photos: "photos",
};

/** One line per audit entry, in the client's words. */
export function describeProductEvent(action: string, changes: Record<string, unknown>): string {
  switch (action) {
    case "created":
      return "Added";
    case "updated": {
      const fields = Object.keys(changes).map((k) => FIELD_WORDS[k] ?? k);
      return fields.length > 0 ? `Changed ${fields.join(", ")}` : "Changed";
    }
    case "activated":
      return "Put on your website";
    case "hidden":
      return "Taken off your website";
    case "deleted":
      return "Deleted";
    case "stock_reserved":
      return "Held for a customer in checkout";
    case "stock_sold":
      return "Sold";
    case "stock_released":
      return "Released from an abandoned checkout";
    case "restocked":
      return "Restocked";
    default:
      return action;
  }
}
