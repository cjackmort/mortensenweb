import type { CheckoutLines } from "@/lib/ads/money";

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export { money as formatCents };

/**
 * The bill: ad spend per channel, then the management fee on its own line,
 * then the total. The same lines go to Stripe, so the receipt matches.
 */
export function CheckoutLinesTable({ lines, caption }: { lines: CheckoutLines; caption?: string }) {
  return (
    <table className="ad-bill">
      {caption ? <caption>{caption}</caption> : null}
      <tbody>
        {lines.items.map((line) => (
          <tr key={line.label} className={line.kind === "fee" ? "ad-bill-fee" : undefined}>
            <th scope="row">{line.label}</th>
            <td>{money(line.cents)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">Total</th>
          <td>{money(lines.totalCents)}</td>
        </tr>
      </tfoot>
    </table>
  );
}
