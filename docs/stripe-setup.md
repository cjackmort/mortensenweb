# Stripe subscriptions

How card subscriptions work in the portal, what has to be true before they can
take real money, and how to undo it.

Companion to `square-setup.md`. Square is not being replaced — see
[Existing providers](#existing-providers-and-migration).

---

## What was already here

Worth stating plainly, because it was not what it looked like:

- **Stripe was not integrated.** No SDK, no environment variables, no webhook
  route, no customer or price columns. The word `stripe` appeared in the
  codebase only as a value in `payment_method` — a label for a payment an
  operator recorded by hand.
- **The sandbox account was empty.** No products, prices, customers or
  subscriptions.
- **Square is the real integration**, with a webhook receiver, a catalogue
  script and a signature verifier.
- The schema had, however, been *designed* for this: `payments.provider` was
  already there, commented "Reserved for Stripe", and
  `subscriptions.provider` / `provider_subscription_id` already existed. Stripe
  uses those rather than a parallel set of `stripe_*` columns.

### Inconsistencies found

| Thing | Status |
|---|---|
| `drizzle-kit generate` is broken on `main` | **Unresolved.** `0014_square_venom` and `0015_internal_client_flag` both descend from the 0013 snapshot — two branches generated from the same parent and both were merged. Migrations 0016–0018 were hand-written to work around it, and so is 0019. Repairing the lineage is a separate change; it touches migration state other branches build on. |
| Two client rosters disagree | The agency-side `clients/_registry.json` (in the `Website Business` repo) lists 9 clients, 8 of them demos. The portal database is seeded separately. Neither is derived from the other. **The portal database is the source of truth for billing**; the registry is a deployment record. |
| Allowance periods vs Stripe periods | See [Billing periods](#billing-periods). Not a defect — a decision that needed making. |

### Prices

Taken from `packages/plans/index.ts`, which is the single definition the public
site and the portal seed both read. **Not** from any older document; the
pricing page and the portal had already drifted once, in September 2026, and
that package exists to stop it happening again.

---

## Plan to price mapping

Canonical. This table is the only approved mapping; checkout resolves a plan
key through it and ignores anything the browser sends.

| Plan key | Price | Included changes | Stripe lookup key |
|---|---|---|---|
| `care-lite` | $50 / month | 1 | `care_lite_monthly_v1` |
| `care-basic` | $100 / month | 5 | `care_basic_monthly_v1` |
| `care-plus` | $200 / month | 15 | `care_plus_monthly_v1` |
| `care-unlimited` | $300 / month | unlimited | `care_unlimited_monthly_v1` |
| `comp-unlimited` | — | unlimited | **none, deliberately** |

`comp-unlimited` has no price and must never be given one. A complimentary plan
with a price attached is a plan a complimentary client can be put through
checkout on.

**Lookup keys, not price ids.** A price id differs between the sandbox and the
live account, so a hardcoded one makes the same commit wrong in one of the two
environments. The lookup key is a string we choose and set identically in both.
The `_v1` suffix exists because Stripe prices are immutable: changing a price
means creating a new one and moving the lookup key.

Sandbox price ids as created (for reference only — nothing reads these):

```
care_lite_monthly_v1       price_1UDVgj5dv299nvoxylcjjfb3   prod_VDxbITWj8y37Zq
care_basic_monthly_v1      price_1UDVgl5dv299nvoxAG0GH6W9   prod_VDxbXBFNpE6Gxe
care_plus_monthly_v1       price_1UDVgu5dv299nvoxvRyPwHc2   prod_VDxbjhwy3ZI2oI
care_unlimited_monthly_v1  price_1UDVgw5dv299nvoxrBsDe2d6   prod_VDxbA2QT2Bo8hf
```

---

## Environment

Names only. Values are secrets and belong in the Netlify environment, never in
the repository.

| Variable | What it is |
|---|---|
| `STRIPE_SECRET_KEY` | Secret or restricted key. **The key decides test vs live** — there is no separate environment variable, because two sources for one fact can disagree and the way they disagree is a deployment that charges real cards believing itself to be in test mode. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for this deployment's endpoint. Each endpoint has its own. |

Unset means Stripe is off: the billing page falls back to Square and manual
payment, and the webhook answers 503 rather than processing anything
unverified.

### Webhook

`POST /api/webhooks/stripe`, subscribed to:

```
checkout.session.completed
checkout.session.async_payment_succeeded
checkout.session.async_payment_failed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
invoice.paid
invoice.payment_failed
invoice.payment_action_required
charge.refunded
charge.dispute.created
```

Anything else is acknowledged and dropped. An allowlist, so enabling a new
event type in the dashboard cannot silently start changing billing state in a
build that has never seen it.

---

## The rules this integration holds to

These are the ones worth knowing before changing anything.

**Visiting the success URL proves nothing.** Access is granted by a settled
invoice arriving on a signature-verified webhook, never by a redirect.

**Settlement is not cash.** `invoice.paid` fires for invoices that collected
nothing — a zero total, one covered by credit, one marked paid by hand. The
ledger records `amount_paid`, so those appear as the zero they are instead of
inflating revenue.

**Allowances are never touched by a payment event.** A change allowance is
created lazily on first use, keyed by `(client, calendar month)`, and granted
by the plan. No path in the webhook grants one. That is why a duplicated or
replayed event cannot double-grant: there is nothing to double.

**Subscription state is re-fetched, never trusted from the payload.** Stripe
does not guarantee ordering. Re-reading the subscription at processing time
means arrival order stops mattering and a stale event cannot resurrect a
cancelled subscription.

**A failed payment never takes a site offline.** It does not pause management
either. Stripe retries, the existing dunning ladder handles the human side,
and billing management stays reachable so the client can fix it.

**Complimentary clients are untouchable.** No payment event modifies a client
with `comp_plan_id` set.

---

## Billing periods

The portal's change allowances run on **calendar months** in the business
timezone. Stripe subscriptions bill on their **anniversary** — whatever day
the client signed up.

These do not line up, and the mismatch is deliberate rather than fixed:

- Allowances stay on calendar months. That is what clients were promised, and
  changing it silently would alter the deal for existing clients.
- Stripe bills on the anniversary, which is its default and needs no
  explanation to a client.

The consequence is that somebody who signs up on the 20th pays on the 20th and
gets a fresh allowance on the 1st. For the first partial month they get a full
allowance for a part-month — generous, in the client's favour, and cheap at
these volumes.

**The alternative, if you want them aligned:** set
`subscription_data.billing_cycle_anchor` to the 1st with
`proration_behavior: "none"`, which makes the partial first period free. That is
a business decision about giving away up to 30 days, so it is not the default.
Ask before changing it.

---

## Existing providers and migration

Square and manual records are preserved untouched. Processor identifiers stay
explicit — `payments.provider` names the processor rather than it being implied
by which column is populated — so Stripe, Square and manual transactions cannot
collide.

**Nothing is auto-migrated.** No payment method is moved, no existing
subscription is cancelled.

### Who needs enrolling

At the time of writing: **nobody, automatically.**

The registry lists one active client, `mitch-bedke-art`, on a
`friends-family` tier at $50/month. Whether that is a complimentary
arrangement or a genuine $50 charge is not recorded anywhere the portal can
read, and the two want opposite handling:

- **Complimentary** → set `comp_plan_id`, and the integration will never
  charge or chase them.
- **Paying** → they enrol through Checkout like anyone else.

**This needs an answer before any live enrolment.** Guessing wrong either
charges a friend who was promised a free site, or quietly stops billing
someone who agreed to pay.

Every other registry entry is a demo and should not be enrolled at all.

### Preventing double billing

A client with an existing Square subscription must have it cancelled *before*
Stripe enrolment, not after — the portal cannot see a Square subscription from
Stripe's side and will not stop you creating both. The checkout guard only
prevents a second *Stripe* subscription.

---

## Going live

**None of this has been done. It all needs approval first.** Everything built
so far runs against the sandbox account `Mortensen Web Co. sandbox`
(`acct_1UAM3V5dv299nvox`).

1. **Create the products and prices in the live account** with the same four
   lookup keys. They must match exactly or checkout finds no price.
2. **Check Stripe's retry and email settings** in the live dashboard —
   Billing → Automatic collection. Decide the retry schedule and, importantly,
   decide whether *Stripe* or the *portal's dunning ladder* sends payment
   reminders. Both will send if both are enabled, and clients will get
   duplicate emails.
3. **Register the live webhook endpoint** at the production URL with the event
   list above. Copy its signing secret.
4. **Set `STRIPE_SECRET_KEY` (live) and `STRIPE_WEBHOOK_SECRET`** in the
   Netlify production environment.
5. **Run migration 0019** against the production database.
6. **Resolve the `mitch-bedke-art` question** above.
7. **Verify with one real, small transaction** — enrol a client you control,
   confirm the invoice settles, confirm the ledger row appears with the right
   amount, then refund it.

Until step 7 passes, automatic billing is not operational, whatever the code
says.

---

## Rollback

In order of severity.

**Stop new enrolments, keep existing billing.** Unset
`STRIPE_SECRET_KEY`. Checkout refuses, the billing page falls back to Square
and manual, and the webhook answers 503. Stripe keeps retrying deliveries for
three days, so anything missed during a short outage arrives on its own.

**Stop everything.** Disable the webhook endpoint in the Stripe dashboard and
pause the subscriptions there. Do **not** delete the endpoint — deleting loses
the delivery history you would need to reconcile afterwards.

**Undo the schema.** Migration 0019 is additive only; nothing outside the
Stripe paths reads its columns.

```sql
ALTER TABLE "payments"       DROP COLUMN IF EXISTS "receipt_url";
ALTER TABLE "subscriptions"  DROP COLUMN IF EXISTS "cancel_at_period_end";
ALTER TABLE "subscriptions"  DROP COLUMN IF EXISTS "current_period_end";
ALTER TABLE "subscriptions"  DROP COLUMN IF EXISTS "provider_status";
ALTER TABLE "service_plans"  DROP COLUMN IF EXISTS "stripe_price_lookup_key";
ALTER TABLE "clients"        DROP COLUMN IF EXISTS "stripe_customer_id";
DROP INDEX IF EXISTS "subscriptions_provider_key";
DROP INDEX IF EXISTS "clients_stripe_customer_key";
```

Payment rows written by the webhook are left alone — the ledger does not delete
payments, and money that arrived still arrived.

**Recovering missed deliveries.** Replay from the Stripe dashboard
(Developers → Webhooks → the endpoint → the event → Resend). The receiver is
idempotent on event id and on invoice id, so replaying a whole day is safe.
`reconcileStripe()` lists what is missing.

---

## Operator checks

- **Unmatched events** — `webhook_deliveries` where `provider = 'stripe'` and
  status is `unmatched`, `failed` or `needs_review`. An event for a customer no
  client claims is recorded rather than guessed at, and needs a human.
- **Reconciliation** — `reconcileStripe()` compares Stripe against the ledger,
  repairs drifted status and paid-through dates, and flags anything ambiguous.
  It is bounded per pass and reports a failure as a failure, never as a clean
  run.
- **Three different numbers.** Recurring revenue (an estimate of what active
  subscriptions will bill — not money), collected cash (what actually arrived,
  from the ledger), and bank payouts (a third figure Stripe holds and settles
  separately). Do not add them together or substitute one for another.
