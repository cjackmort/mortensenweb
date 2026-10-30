import { zonedDayStart } from "@/lib/analytics/filters";

/**
 * A store's sales, as the shop page sums them. Pure: the repository reads
 * the orders, this decides what counts.
 *
 * ## What counts as a sale
 *
 * An order Stripe says was paid, and that has not been refunded since —
 * `paid` (waiting to be sent) and `shipped` (sent or collected). The figure
 * is what the customer paid, shipping and tax included, before Stripe's card
 * fee: the same "gross" Stripe's own dashboard shows, so the two agree.
 *
 * ## Refunds
 *
 * A refunded order is left out of the sales figure in full and counted on
 * its own line instead. The portal records *that* an order was refunded,
 * not how much (`recordShopRefund` marks a partial refund as a refund too),
 * so the page says so rather than guessing at a net figure. Stripe has the
 * exact amounts.
 *
 * ## Which period
 *
 * An order belongs to the period it was paid in, in the client's own time
 * zone. A refund later on takes it out of that period's sales; it does not
 * subtract from the month the refund happened in.
 */

export type SaleStatus = "paid" | "shipped" | "refunded";

export interface SaleRow {
  status: SaleStatus;
  totalCents: number;
  /** Units across the order's lines. */
  units: number;
  paidAt: Date;
}

export interface PeriodSales {
  /** What customers paid for orders that stand. */
  salesCents: number;
  orders: number;
  units: number;
  /** Orders paid in the period and refunded since, at what they sold for. */
  refundedOrders: number;
  refundedCents: number;
}

export interface SalesSummary {
  thisMonth: PeriodSales;
  last30Days: PeriodSales;
}

export const SALES_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight on the 1st of this month, in the client's time zone. */
export function monthStart(now: Date, timeZone: string): Date {
  // en-CA formats as YYYY-MM-DD.
  const today = now.toLocaleDateString("en-CA", { timeZone });
  return new Date(zonedDayStart(`${today.slice(0, 7)}-01`, timeZone));
}

/** How far back the summary reads: the earlier of the month's start and 30 days ago. */
export function salesWindowStart(now: Date, timeZone: string): Date {
  const rolling = now.getTime() - SALES_WINDOW_DAYS * DAY_MS;
  return new Date(Math.min(rolling, monthStart(now, timeZone).getTime()));
}

function sumFrom(rows: SaleRow[], since: Date, now: Date): PeriodSales {
  const sums: PeriodSales = { salesCents: 0, orders: 0, units: 0, refundedOrders: 0, refundedCents: 0 };
  for (const row of rows) {
    if (row.paidAt < since || row.paidAt > now) continue;
    if (row.status === "refunded") {
      sums.refundedOrders += 1;
      sums.refundedCents += row.totalCents;
      continue;
    }
    sums.salesCents += row.totalCents;
    sums.orders += 1;
    sums.units += row.units;
  }
  return sums;
}

export function summariseSales(rows: SaleRow[], now: Date, timeZone: string): SalesSummary {
  return {
    thisMonth: sumFrom(rows, monthStart(now, timeZone), now),
    last30Days: sumFrom(rows, new Date(now.getTime() - SALES_WINDOW_DAYS * DAY_MS), now),
  };
}

const NAMED_LINES = 2;

/** "2 × Mug, Bowl and 2 more": an order in one line, for a list of orders. */
export function itemsLabel(items: Array<{ name: string; quantity: number }>): string {
  if (items.length === 0) return "No items recorded";
  const named = items
    .slice(0, NAMED_LINES)
    .map((item) => (item.quantity === 1 ? item.name : `${item.quantity} × ${item.name}`))
    .join(", ");
  const rest = items.length - NAMED_LINES;
  return rest > 0 ? `${named} and ${rest} more` : named;
}
