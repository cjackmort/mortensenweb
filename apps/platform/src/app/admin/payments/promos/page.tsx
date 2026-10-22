import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { adminContextFrom } from "@/db/repositories/context";
import { listPromoCodes } from "@/db/repositories/admin/build-promos";
import { formatDateWithYear } from "@/lib/time";
import { NewPromoCodeForm, SwitchOffButton } from "./promo-code-forms";

export const dynamic = "force-dynamic";

export const metadata = { title: "Promo codes" };

/**
 * Promo codes for the website price.
 *
 * A client types one in their cart and it comes off the build, never off a
 * plan or an add-on. Codes made here are restricted that way for you. Codes
 * made in the Stripe dashboard are listed too, marked by whether the cart
 * accepts them: one that would also come off the monthly payments is refused
 * there, with a plain reason.
 */
export default async function PromoCodesPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role !== "admin") redirect("/dashboard");

  const listing = await listPromoCodes(adminContextFrom(user));

  return (
    <main className="shell">
      <div className="masthead">
        <h1>
          Promo codes<span className="masthead-sub">Website price only</span>
        </h1>
        <span className="muted">
          <Link href="/admin/payments">← Payments</Link>
        </span>
      </div>

      {!listing.ready ? (
        <p className="notice">{listing.message}</p>
      ) : (
        <>
          <section className="card" aria-labelledby="promo-new">
            <div className="card-head">
              <h2 id="promo-new">New code</h2>
            </div>
            <p className="muted" style={{ marginTop: 0 }}>
              Comes off the website price once, at checkout. Plans and add-ons are never discounted.
            </p>
            <NewPromoCodeForm />
          </section>

          <section className="card" aria-labelledby="promo-live">
            <div className="card-head">
              <h2 id="promo-live">Live codes</h2>
              <span className="muted">{listing.rows.length}</span>
            </div>
            {listing.rows.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                No live codes.
              </p>
            ) : (
              <div className="table-wrap">
                <table className="stack">
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Takes off</th>
                      <th>In the cart</th>
                      <th>Used</th>
                      <th>Expires</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {listing.rows.map((row) => (
                      <tr key={row.id}>
                        <td data-label="Code">
                          <code>{row.code}</code>
                        </td>
                        <td data-label="Takes off">{row.terms}</td>
                        <td data-label="In the cart">
                          {row.buildOnly ? (
                            <span className="pill pill-success">Works</span>
                          ) : (
                            <span className="pill pill-warning" title="It would also come off monthly payments">
                              Refused: not website-only
                            </span>
                          )}
                          {row.forOneCustomer && <span className="muted"> · one customer</span>}
                        </td>
                        <td data-label="Used">
                          {row.timesRedeemed}
                          {row.maxRedemptions !== null ? ` of ${row.maxRedemptions}` : ""}
                        </td>
                        <td data-label="Expires">{row.expiresAt ? formatDateWithYear(row.expiresAt) : "Never"}</td>
                        <td data-label="">
                          <SwitchOffButton id={row.id} code={row.code} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
