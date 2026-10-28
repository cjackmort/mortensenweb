import type { EmailMessage } from "@/lib/email/mailer";
import { fromHeader } from "@/lib/growth/lead-reply";
import { money } from "./money";

/**
 * The two emails a shop sends: one to the client when an order is paid, one
 * to the buyer when it ships. Short, plain, and nothing in them the portal
 * did not see Stripe confirm.
 */

export interface OrderLine {
  name: string;
  quantity: number;
  unitCents: number;
}

export interface ShippingAddress {
  name?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function oneLine(value: string, max: number): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function addressLines(address: ShippingAddress | null): string[] {
  if (!address) return [];
  const cityLine = [address.city, address.state, address.postalCode].filter(Boolean).join(", ");
  return [address.name, address.line1, address.line2, cityLine, address.country].filter((l): l is string => Boolean(l && l.trim()));
}

function linesHtml(lines: string[]): string {
  return lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("");
}

export interface NewOrderInput {
  to: string;
  businessName: string;
  orderPublicId: string;
  buyerName: string | null;
  buyerEmail: string | null;
  fulfilment: "ship" | "pickup";
  items: OrderLine[];
  totalCents: number;
  shippingAddress: ShippingAddress | null;
  ordersUrl: string;
}

/** To the client: somebody bought something. */
export function buildNewOrderEmail(input: NewOrderInput): EmailMessage {
  const items = input.items.map((i) => `${i.quantity} × ${oneLine(i.name, 80)} — ${money(i.unitCents * i.quantity)}`);
  const who = [input.buyerName, input.buyerEmail].filter(Boolean).map((v) => oneLine(String(v), 80)).join(", ") || "A customer";
  const address = addressLines(input.shippingAddress);
  const next = input.fulfilment === "ship" ? "Post it, then mark it shipped in your portal and the customer gets an email." : "They will collect it. Mark it done in your portal when they have.";

  const text = [
    `New order on your website: ${money(input.totalCents)}.`,
    "",
    ...items,
    "",
    `From: ${who}`,
    ...(address.length ? ["Ship to:", ...address, ""] : [""]),
    next,
    "",
    `Your orders: ${input.ordersUrl}`,
  ].join("\n");

  const html = `<!doctype html><html><body style="margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;font-size:15px;line-height:1.55">
<div style="max-width:600px;padding:16px">
<p style="margin:0 0 14px">New order on your website: <strong>${money(input.totalCents)}</strong>.</p>
<p style="margin:0 0 14px">${items.map(escapeHtml).join("<br>")}</p>
<p style="margin:0 0 14px">From: ${escapeHtml(who)}</p>
${address.length ? `<p style="margin:0 0 14px">Ship to:<br>${linesHtml(address)}</p>` : ""}
<p style="margin:0 0 14px">${escapeHtml(next)}</p>
<p style="margin:0"><a href="${escapeHtml(input.ordersUrl)}">Your orders</a></p>
</div></body></html>`;

  return {
    to: input.to,
    subject: `New order: ${money(input.totalCents)} — ${oneLine(input.items[0]?.name ?? "your shop", 50)}`,
    text,
    html,
    idempotencyKey: `shop-order-new:${input.orderPublicId}:${input.to}`,
    tags: [
      { name: "feature", value: "shop" },
      { name: "order", value: input.orderPublicId },
    ],
  };
}

export interface OrderShippedInput {
  to: string;
  businessName: string;
  senderAddress: string;
  replyTo: string | null;
  orderPublicId: string;
  items: OrderLine[];
  shippingAddress: ShippingAddress | null;
  shippingPolicy: string | null;
}

/** To the buyer, from the business: it is on its way. */
export function buildOrderShippedEmail(input: OrderShippedInput): EmailMessage {
  const business = oneLine(input.businessName, 60) || "The shop";
  const items = input.items.map((i) => `${i.quantity} × ${oneLine(i.name, 80)}`);
  const address = addressLines(input.shippingAddress);

  const text = [
    `Your order from ${business} is on its way.`,
    "",
    ...items,
    "",
    ...(address.length ? ["Going to:", ...address, ""] : []),
    ...(input.shippingPolicy ? [oneLine(input.shippingPolicy, 500), ""] : []),
    "Reply to this email with any questions and it comes straight to us.",
    "",
    business,
  ].join("\n");

  const html = `<!doctype html><html><body style="margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;font-size:15px;line-height:1.55">
<div style="max-width:600px;padding:16px">
<p style="margin:0 0 14px">Your order from <strong>${escapeHtml(business)}</strong> is on its way.</p>
<p style="margin:0 0 14px">${items.map(escapeHtml).join("<br>")}</p>
${address.length ? `<p style="margin:0 0 14px">Going to:<br>${linesHtml(address)}</p>` : ""}
${input.shippingPolicy ? `<p style="margin:0 0 14px">${escapeHtml(oneLine(input.shippingPolicy, 500))}</p>` : ""}
<p style="margin:0 0 14px">Reply to this email with any questions and it comes straight to us.</p>
<p style="margin:0">${escapeHtml(business)}</p>
</div></body></html>`;

  return {
    to: input.to,
    from: fromHeader(business, input.senderAddress),
    replyTo: input.replyTo ?? undefined,
    bcc: input.replyTo ?? undefined,
    subject: `Your order from ${business} has shipped`,
    text,
    html,
    idempotencyKey: `shop-order-shipped:${input.orderPublicId}`,
    tags: [
      { name: "feature", value: "shop" },
      { name: "order", value: input.orderPublicId },
    ],
  };
}
