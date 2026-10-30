import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { requireUsableGrowthFeature } from "@/db/repositories/client/growth";
import { listOrders, type OrderView } from "@/db/repositories/client/shop-orders";
import { addressLines } from "@/lib/shop/emails";
import { money } from "@/lib/shop/money";
import { formatDateTime } from "@/lib/time";
import { MarkShippedButton, RestockButton } from "./order-controls";
import "../shop.css";

/**
 * Orders, newest first: who bought what, where it goes, and whether it has
 * gone. Only paid orders; a checkout that was never paid is not an order.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Orders",
  robots: { index: false, follow: false },
};

const PILL: Record<OrderView["status"], { label: string; tone: string }> = {
  paid: { label: "To send", tone: "pill-warning" },
  shipped: { label: "Sent", tone: "pill-success" },
  refunded: { label: "Refunded", tone: "pill-neutral" },
};

export default async function OrdersPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.organizationId) redirect("/dashboard");

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  if (!(await requireUsableGrowthFeature(db, ctx, "shop"))) redirect("/dashboard/growth?locked=shop#shop");

  const orders = await listOrders(db, ctx);
  const readOnly = ctx.impersonating;
  const toSend = orders.filter((o) => o.status === "paid").length;

  return (
    <main className="shell">
      <div className="masthead">
        <h1>Orders</h1>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>{orders.length === 0 ? "Orders" : `${orders.length} ${orders.length === 1 ? "order" : "orders"}`}</h2>
          {toSend > 0 && <span className="panel-sub">{toSend} to send</span>}
        </div>
        <div className="panel-body">
          {orders.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              No orders yet. They appear here the moment a customer pays.
            </p>
          ) : (
            <ul className="shop-orders">
              {orders.map((order) => (
                <Order key={order.publicId} order={order} readOnly={readOnly} />
              ))}
            </ul>
          )}
        </div>
      </section>

      <p className="panel-note">
        Refunds are made in your Stripe dashboard. A refunded order shows here, and you choose whether to restock it.
      </p>
    </main>
  );
}

function Order({ order, readOnly }: { order: OrderView; readOnly: boolean }) {
  const pill = order.status === "shipped" && order.fulfilment === "pickup" ? { label: "Collected", tone: "pill-success" } : PILL[order.status];
  const address = addressLines(order.shippingAddress);
  return (
    <li className="shop-order">
      <div className="shop-order-head">
        <span className={`pill ${pill.tone}`}>{pill.label}</span>
        <strong>{money(order.totalCents)}</strong>
        <span className="muted">Paid {formatDateTime(order.paidAt)}</span>
        {order.shippedAt && <span className="muted">{order.fulfilment === "pickup" ? "Collected" : "Sent"} {formatDateTime(order.shippedAt)}</span>}
        {order.refundedAt && <span className="muted">Refunded {formatDateTime(order.refundedAt)}</span>}
      </div>
      <ul className="shop-order-lines">
        {order.items.map((item, i) => (
          <li key={i}>
            {item.quantity} × {item.productPublicId ? <Link href={`/dashboard/growth/shop/products/${item.productPublicId}`}>{item.name}</Link> : item.name}{" "}
            <span className="muted">{money(item.unitCents * item.quantity)}</span>
          </li>
        ))}
        {order.shippingCents > 0 && (
          <li className="muted">Shipping {money(order.shippingCents)}</li>
        )}
        {order.taxCents > 0 && <li className="muted">Tax {money(order.taxCents)}</li>}
      </ul>
      <div className="shop-order-buyer">
        <span>{order.buyerName ?? "No name given"}</span>
        {order.buyerEmail && <a href={`mailto:${order.buyerEmail}`}>{order.buyerEmail}</a>}
        {address.length > 0 && <address className="shop-order-address">{address.join(", ")}</address>}
        {order.fulfilment === "pickup" && <span className="muted">Collecting in person</span>}
      </div>
      {order.status === "paid" && <MarkShippedButton publicId={order.publicId} pickup={order.fulfilment === "pickup"} readOnly={readOnly} />}
      {order.status === "refunded" && !order.restocked && <RestockButton publicId={order.publicId} readOnly={readOnly} />}
      {order.status === "refunded" && order.restocked && <p className="muted shop-order-note">Restocked.</p>}
    </li>
  );
}
