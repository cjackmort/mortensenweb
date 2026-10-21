"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { formatCents, quoteCart, type CartCatalog, type CartPlan } from "@/lib/billing/cart";
import { checkPromoAction, startCartCheckoutAction, type CartCheckoutResult } from "./actions";

/**
 * The cart: the build, a plan, add-ons, a promo code, and a total that keeps
 * up as boxes are ticked.
 *
 * The total comes from `quoteCart`, the same function the server charges
 * from, and the discounted build price from the server's own check of the
 * code — so what this shows is what Stripe is asked for. The form posts keys
 * and the code as typed; the server works out every amount again.
 */

interface AppliedPromo {
  code: string;
  terms: string;
  buildDueCents: number;
}

function planTag(plan: CartPlan): string | null {
  if (plan.recommended) return "Suggested for you";
  if (plan.featured) return "Most popular";
  return null;
}

export function CartForm({
  catalog,
  attachedPromo,
  now,
  timeZone,
}: {
  catalog: CartCatalog;
  attachedPromo: AppliedPromo | null;
  /** The server's clock, so the first render here matches the server's. */
  now: string;
  timeZone: string;
}) {
  const recommended = catalog.plans.find((p) => p.recommended)?.key ?? null;
  const [planKey, setPlanKey] = useState<string | null>(recommended);
  const [addOnKeys, setAddOnKeys] = useState<string[]>([]);
  const [promo, setPromo] = useState<AppliedPromo | null>(attachedPromo);
  const [promoInput, setPromoInput] = useState("");
  const [promoError, setPromoError] = useState<string | null>(null);
  const [checking, startChecking] = useTransition();
  const [result, checkout, paying] = useActionState<CartCheckoutResult | null, FormData>(startCartCheckoutAction, null);

  const plan = catalog.plans.find((p) => p.key === planKey) ?? null;
  const chosenAddOns = addOnKeys.filter((key) => !plan?.includes.includes(key));
  const quote = quoteCart(
    catalog,
    { planKey, addOnKeys: chosenAddOns },
    promo?.buildDueCents ?? catalog.build.priceCents,
    new Date(now),
  );
  const date = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });

  // Stripe hands back a URL rather than the server redirecting, so a refusal
  // leaves the client here with the reason.
  useEffect(() => {
    if (result?.ok) window.location.href = result.url;
  }, [result]);

  function choosePlan(key: string | null) {
    setPlanKey(key);
    if (!key) setAddOnKeys([]);
  }

  function toggleAddOn(key: string, on: boolean) {
    setAddOnKeys((current) => (on ? [...current, key] : current.filter((k) => k !== key)));
  }

  function applyPromo() {
    setPromoError(null);
    startChecking(async () => {
      const checked = await checkPromoAction(promoInput);
      if (checked.ok) {
        setPromo({ code: checked.code, terms: checked.terms, buildDueCents: checked.buildDueCents });
        setPromoInput("");
      } else {
        setPromoError(checked.message);
      }
    });
  }

  const build = quote.lines[0]!;

  return (
    <form action={checkout} className="cart">
      <input type="hidden" name="planKey" value={planKey ?? ""} />
      {chosenAddOns.map((key) => (
        <input key={key} type="hidden" name="addOn" value={key} />
      ))}
      <input type="hidden" name="promoCode" value={promo?.code ?? ""} />

      <div className="cart-choices">
        <section className="card cart-build" aria-labelledby="cart-build">
          <div className="card-head">
            <h2 id="cart-build">
              Your website
              {/* The build's own name, when the catalogue has more than "Website". */}
              {catalog.build.name !== "Website" && <span className="muted cart-build-name"> · {catalog.build.name}</span>}
            </h2>
            <span className="pill pill-neutral">Required</span>
          </div>
          <p className="cart-build-price">
            {promo ? <s>{formatCents(build.listCents)}</s> : null}
            <strong>{formatCents(build.cents)}</strong>
            <span> one payment</span>
          </p>
          {promo && <p className="cart-promo-note">{promo.code}: {promo.terms}</p>}
          <ul className="plan-features">
            {catalog.build.includes.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>

        <fieldset className="card cart-plans">
          <legend>
            <h2>Monthly plan</h2>
            <span className="muted">Optional</span>
          </legend>
          <label className={`cart-option${planKey === null ? " is-chosen" : ""}`}>
            <input type="radio" name="plan" checked={planKey === null} onChange={() => choosePlan(null)} />
            <span className="cart-option-body">
              <strong>No plan for now</strong>
              <span className="muted">We hand the finished site over to you at launch.</span>
            </span>
          </label>
          {catalog.plans.map((option) => {
            const tag = planTag(option);
            return (
              <label key={option.key} className={`cart-option${planKey === option.key ? " is-chosen" : ""}`}>
                <input type="radio" name="plan" checked={planKey === option.key} onChange={() => choosePlan(option.key)} />
                <span className="cart-option-body">
                  <span className="cart-option-head">
                    <strong>{option.name}</strong>
                    {tag && <span className="plan-tag">{tag}</span>}
                    <span className="cart-option-price">
                      {formatCents(option.monthlyCents)}
                      <small>/month</small>
                    </span>
                  </span>
                  <span className="muted">{option.description}</span>
                </span>
              </label>
            );
          })}
        </fieldset>

        {catalog.addOns.length > 0 && (
          <fieldset className="card cart-addons" disabled={!plan}>
            <legend>
              <h2>Growth add-ons</h2>
              <span className="muted">{plan ? "Optional" : "Choose a plan to add these"}</span>
            </legend>
            {catalog.addOns.map((addOn) => {
              const included = plan?.includes.includes(addOn.key) ?? false;
              return (
                <label key={addOn.key} className={`cart-option${included ? " is-included" : ""}`}>
                  <input
                    type="checkbox"
                    checked={included || chosenAddOns.includes(addOn.key)}
                    disabled={included}
                    onChange={(event) => toggleAddOn(addOn.key, event.target.checked)}
                  />
                  <span className="cart-option-body">
                    <span className="cart-option-head">
                      <strong>{addOn.name}</strong>
                      <span className="cart-option-price">
                        {included ? `Included in ${plan!.name}` : (
                          <>
                            {formatCents(addOn.monthlyCents)}
                            <small>/month</small>
                          </>
                        )}
                      </span>
                    </span>
                    <span className="muted">{addOn.summary}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        )}
      </div>

      <aside className="card cart-summary" aria-labelledby="cart-summary">
        <h2 id="cart-summary">Your order</h2>
        <ul className="cart-lines">
          {quote.lines.map((line) => (
            <li key={`${line.kind}:${line.key}`}>
              <span>
                {line.kind === "build" ? "Website" : line.kind === "plan" ? `${line.name} plan` : line.name}
                {line.recurring && <span className="muted"> · {formatCents(line.cents)}/month</span>}
              </span>
              {line.kind === "build" ? (
                <span>
                  {line.cents !== line.listCents && <s>{formatCents(line.listCents)}</s>} {formatCents(line.cents)}
                </span>
              ) : null}
            </li>
          ))}
          {quote.monthlyCents > 0 && (
            <li>
              <span>
                {quote.prorated && quote.renewsOn ? `First payment, to ${date(quote.renewsOn)}` : "First month"}
              </span>
              <span>{formatCents(quote.firstPeriodCents)}</span>
            </li>
          )}
        </ul>

        <div className="cart-promo">
          {promo ? (
            <p className="cart-promo-applied">
              <span>
                <strong>{promo.code}</strong> · {promo.terms}
              </span>
              <button type="button" className="link" onClick={() => setPromo(null)}>
                Remove
              </button>
            </p>
          ) : (
            <>
              <label htmlFor="promo-code">Promo code</label>
              <div className="cart-promo-row">
                <input
                  id="promo-code"
                  value={promoInput}
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setPromoInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      applyPromo();
                    }
                  }}
                />
                <button type="button" className="secondary" disabled={checking || !promoInput.trim()} onClick={applyPromo}>
                  {checking ? "Checking…" : "Apply"}
                </button>
              </div>
              {promoError && (
                <p className="error" role="alert">
                  {promoError}
                </p>
              )}
            </>
          )}
        </div>

        <dl className="cart-total">
          <dt>Due today</dt>
          <dd>{formatCents(quote.dueTodayCents)}</dd>
        </dl>
        {quote.renewsOn && (
          <p className="cart-then">
            Then {formatCents(quote.monthlyCents)}/month from {date(quote.renewsOn)}
          </p>
        )}

        {result && !result.ok && <p className="notice notice-danger">{result.message}</p>}
        <button type="submit" className="cart-pay" disabled={paying || result?.ok === true}>
          {paying || result?.ok ? "Opening Stripe…" : `Pay ${formatCents(quote.dueTodayCents)}`}
        </button>
        <p className="muted cart-fine">
          You&rsquo;ll enter your card on Stripe&rsquo;s secure page, not here.
          {quote.monthlyCents > 0 && " Cancel your plan or any add-on from the Plan tab in one click."}
        </p>
      </aside>
    </form>
  );
}
