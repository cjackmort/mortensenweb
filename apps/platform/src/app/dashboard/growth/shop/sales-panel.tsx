import Link from "next/link";
import type { RecentOrder, ShopSalesView } from "@/db/repositories/client/shop-sales";
import { money } from "@/lib/shop/money";
import { itemsLabel, type PeriodSales } from "@/lib/shop/sales";
import { formatDate } from "@/lib/time";

/**
 * "See their sales": what came in, what sells, and the latest orders.
 *
 * Three states, and none of them is a row of $0.00 standing in for "nothing
 * has happened yet": a shop that has not sold says so in words, a shop whose
 * figures could not be read says that, and only a shop that has sold shows
 * figures — where a quiet month's $0.00 is the true answer.
 */

const ORDERS_PATH = "/dashboard/growth/shop/orders";

function orderPill(order: Pick<RecentOrder, "status" | "fulfilment">): { label: string; tone: string } {
  if (order.status === "paid") return { label: "To send", tone: "pill-warning" };
  if (order.status === "refunded") return { label: "Refunded", tone: "pill-neutral" };
  return { label: order.fulfilment === "pickup" ? "Collected" : "Sent", tone: "pill-success" };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function periodNote(period: PeriodSales, quiet: string): string {
  return period.orders === 0 ? quiet : plural(period.orders, "order", "orders");
}

export type SalesState =
  | { kind: "ready"; sales: ShopSalesView }
  | { kind: "failed" };

export function SalesPanel({
  state,
  toSend,
  chargesEnabled,
  onSite,
}: {
  state: SalesState;
  toSend: number;
  chargesEnabled: boolean;
  onSite: number;
}) {
  return (
    <section className="panel shop-sales" aria-labelledby="shop-sales">
      <div className="panel-head">
        <h2 id="shop-sales">Sales</h2>
        <div className="panel-head-actions">
          <Link href={ORDERS_PATH}>All orders</Link>
        </div>
      </div>
      <SalesBody state={state} toSend={toSend} chargesEnabled={chargesEnabled} onSite={onSite} />
    </section>
  );
}

function SalesBody({
  state,
  toSend,
  chargesEnabled,
  onSite,
}: {
  state: SalesState;
  toSend: number;
  chargesEnabled: boolean;
  onSite: number;
}) {
  if (state.kind === "failed") {
    return (
      <div className="panel-body">
        <p className="error" role="status" style={{ margin: 0 }}>
          Your sales figures could not be loaded just now. Your orders are safe; reload the page in a minute, or see{" "}
          <Link href={ORDERS_PATH}>all orders</Link>.
        </p>
      </div>
    );
  }

  const { sales } = state;
  if (!sales.everSold) {
    return (
      <div className="panel-body">
        <p className="shop-sales-empty">No sales yet.</p>
        <p className="muted" style={{ margin: 0 }}>
          {!chargesEnabled
            ? "Once Stripe is connected and a customer buys something on your website, the money and the order show up here."
            : onSite === 0
              ? "Put a product on your website, and the moment a customer pays, the sale shows up here."
              : "Your shop is open. The moment a customer pays, the sale shows up here and we email you."}
        </p>
      </div>
    );
  }

  const { thisMonth, last30Days } = sales.summary;
  const month = new Date().toLocaleDateString("en-US", { month: "long", timeZone: sales.timeZone });
  const refunded = last30Days.refundedOrders;

  return (
    <>
      <div className="metrics">
        <div className="metric">
          <p className="metric-label">{month}</p>
          <p className="metric-value">{money(thisMonth.salesCents)}</p>
          <p className="metric-note">{periodNote(thisMonth, "No orders yet this month")}</p>
        </div>
        <div className="metric">
          <p className="metric-label">Last 30 days</p>
          <p className="metric-value">{money(last30Days.salesCents)}</p>
          <p className="metric-note">{periodNote(last30Days, "No orders in 30 days")}</p>
        </div>
        <div className="metric">
          <p className="metric-label">Items sold</p>
          <p className="metric-value">{last30Days.units}</p>
          <p className="metric-note">In the last 30 days</p>
        </div>
        <div className="metric">
          <p className="metric-label">To send</p>
          <p className="metric-value">{toSend}</p>
          <p className="metric-note">
            {toSend === 0 ? "Nothing waiting" : <Link href={ORDERS_PATH}>{toSend === 1 ? "See the order" : "See them"}</Link>}
          </p>
        </div>
      </div>

      <div className="panel-split panel-split-2">
        <div>
          <h3>Best sellers</h3>
          <BestSellers sales={sales} />
        </div>
        <div>
          <h3>Latest orders</h3>
          <RecentOrders orders={sales.recent} />
        </div>
      </div>

      <div className="panel-body">
        {refunded > 0 && (
          <p className="shop-sales-refunds">
            {plural(refunded, "order", "orders")} from the last 30 days {refunded === 1 ? "was" : "were"} refunded (
            {money(last30Days.refundedCents)} at the time of sale) and {refunded === 1 ? "is" : "are"} not counted
            above. If you refunded only part of an order, your Stripe dashboard has the exact amount.
          </p>
        )}
        <p className="panel-note" style={{ marginTop: refunded > 0 ? undefined : 0 }}>
          What customers paid, including shipping and tax, before Stripe&apos;s fees. Payouts are in your Stripe
          dashboard.
        </p>
      </div>
    </>
  );
}

function BestSellers({ sales }: { sales: ShopSalesView }) {
  if (sales.bestSellers.length === 0) {
    return <p className="muted" style={{ margin: 0 }}>Nothing sold that has not been refunded.</p>;
  }
  return (
    <ol className="shop-best">
      {sales.bestSellers.map((item) => (
        <li key={item.productPublicId ?? `deleted:${item.name}`}>
          <span className="shop-best-name">
            {item.productPublicId ? (
              <Link href={`/dashboard/growth/shop/products/${item.productPublicId}`}>{item.name}</Link>
            ) : (
              item.name
            )}
          </span>
          <span className="shop-best-figures">
            {plural(item.units, "sold", "sold")} · {money(item.salesCents)}
          </span>
        </li>
      ))}
    </ol>
  );
}

function RecentOrders({ orders }: { orders: RecentOrder[] }) {
  return (
    <>
      <ul className="shop-recent">
        {orders.map((order) => {
          const pill = orderPill(order);
          return (
            <li key={order.publicId}>
              <div className="shop-recent-main">
                <span className="shop-recent-what">{itemsLabel(order.items)}</span>
                <span className="shop-recent-who">
                  {order.buyerName ?? "No name given"} · {formatDate(order.paidAt)}
                </span>
              </div>
              <div className="shop-recent-side">
                <span className="shop-recent-total">{money(order.totalCents)}</span>
                <span className={`pill ${pill.tone}`}>{pill.label}</span>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="panel-note">
        <Link href={ORDERS_PATH}>All orders</Link>, with addresses and the buttons to mark them sent.
      </p>
    </>
  );
}
