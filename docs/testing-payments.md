# Testing payments

How to run the whole money flow — a new client signs in, pays for the site and
a plan, Stripe tells the portal, the portal lets them in — without touching
live Stripe or the production database. There are three ways to look at it,
and each one proves something the others cannot.

| | Local run | Staging, Stripe test mode | One live dollar |
| --- | --- | --- | --- |
| Portal code, start to finish: sign-in, welcome page, checkout, webhook, ledger, unlock | yes | yes | yes |
| Stripe's real behaviour: price lookup, session contents, signatures, retries, API version | **no** — the stand-in is written from how the portal uses Stripe, so a wrong assumption is shared by both sides | yes | yes |
| Netlify itself: build-time env, function runtime, cold starts | no | yes | yes |
| A real card and a real bank | no | no (test cards) | yes |
| Costs | nothing | nothing | $1 and a refund |
| Takes | about two minutes | an afternoon, once; then minutes | minutes |

Run the local one before and after any change to checkout, the webhook or the
unlock. Run staging before anything that changes what Stripe is asked to
charge. The live dollar is `docs/stripe-setup.md` → "Going live", step 7, and
the `test-plan` ($1) exists for it.

---

## 1. Locally

```bash
npm ci                                              # once, at the repository root
npm run e2e:checkout --workspace apps/platform
```

That one command:

1. deletes and rebuilds a throwaway database, `apps/platform/.pglite-e2e`
   (never `.pglite`, the one your dev server uses), and applies the migrations;
2. seeds two clients standing at the welcome page, plus an admin
   (`scripts/preview/seed-welcome.ts`), and writes their generated sign-in
   details to `apps/platform/.e2e/credentials.json` — git-ignored, never printed;
3. starts the Stripe stand-in on `:12111` and the portal on `:3100`, with
   `sk_test_` keys that exist only for this run;
4. drives a browser through the flow and asserts the result.

To watch it, add Playwright's flags after `--`: `-- --headed`, or `-- --ui` to
step through.

**The browser.** On Windows it uses the Edge that ships with the system, so
nothing downloads. Elsewhere run `npx playwright install chromium` once. To
force one, set `E2E_BROWSER_CHANNEL` (`chrome`, `msedge`).

**What it can't touch.** The run sets its own environment on top of whatever is
in `apps/platform/.env.local`: `DATABASE_URL` is blanked, Stripe points at the
stand-in, and the mail, Square and Twilio credentials are blanked. A variable
that is already set is never overwritten by an env file, which is what makes
that hold. `seed:welcome` itself refuses to run if `DATABASE_URL` is set at all.

### What the two cases check

| Client | Does | Expects |
| --- | --- | --- |
| `welcome-build` — nothing raised yet | Signs in with the temporary password, chooses their own, picks Care, pays $550 (the build and the plan) on the stand-in | `checkout.session.completed`, `customer.subscription.created` and `invoice.paid` are each answered 200 *processed*; "Pay for your website" is done; the request form is open; Billing's ledger has one row of $550.00 |
| `welcome-invoice` — an operator already raised the $500 build invoice | Picks Care alone and pays $50 | The same three events processed and a single $50.00 row (passes), **and** the site still counted as unpaid with change requests still locked (**known to fail** — see below) |

The last check is marked `test.fail()` and points at roadmap P1.3. Today any
invoice that collects money unlocks the client, so paying for a plan lets in
someone who still owes the build. Playwright reports that test as passed because
it failed as expected; when P1.3 lands it reports *expected to fail, but
passed* — delete the `test.fail()` line then. The test is split from the one
that records the payment so that a break in getting that far cannot pass for
the known failure.

### Reading a failure

`apps/platform/test-results/` holds a trace for each failure
(`npx playwright show-trace <trace.zip>`). The stand-in logs every call it
answers, and `GET http://localhost:12111/__fake/events` lists the events it
delivered with the portal's answer to each. A webhook answered anything but
200 *processed* — `unmatched`, `ignored`, a 401 — is the usual cause.

### Changing the flow

`e2e/checkout.spec.ts` is a list of steps; `e2e/steps.ts` is where each step
knows its labels and paths. Decision D1 (the client sees the built preview
first and pays the build at go-live) moves the build payment later in the
list and out of the welcome page: reorder the steps in the spec, replace
`arriveAtWelcomePage` / `choosePlan` / `continueToPayment` with the new entry
points, and leave `payOnStripe`, `eventsDelivered` and the `expect…` helpers
alone.

### What the stand-in does and doesn't do

`scripts/preview/fake-stripe.ts` answers what the welcome checkout calls:
customers, prices by lookup key, subscriptions, and Checkout Sessions in
`subscription` and `payment` mode, with the prices from `@mortensenweb/plans`.
Its checkout page has a Pay button; pressing it completes the session and posts
the signed events to the portal, waiting for each answer before redirecting.

It does **not** do promotion codes (a session asking for one is refused),
tax, proration, billing-cycle anchors, renewals, failed cards, refunds or
disputes. Anything unrecognised is answered 404 with the URL so a gap is a
failure, not a plausible wrong answer. Adding one is a route in the table and,
if it produces an event, a line in `completeSession`. The promo codes in
roadmap P1.4 will need coupons added here.

It is also written from the portal's reading of Stripe, not from Stripe. Where
the two disagree the stand-in is wrong and nothing local will say so — that is
what staging is for.

---

## 2. Staging, with Stripe in test mode

A branch deploy of a `staging` branch, with Stripe test keys, a test-mode
webhook pointed at its stable URL, and a throwaway database. Deploy *previews*
cannot receive webhooks: their URL changes with every pull request, so a
Stripe endpoint cannot point at one. A preview can create test Checkout
Sessions (so it proves the session is built correctly) but the portal is never
told they were paid.

Nothing here changes production. Do it in this order.

**1. Make live keys production-only.** In Netlify → Site configuration →
Environment variables, for each of `STRIPE_SECRET_KEY` and
`STRIPE_WEBHOOK_SECRET` (and `STRIPE_CONNECT_WEBHOOK_SECRET` if set): edit it,
choose *Different value for each deploy context*, and set

| Context | `STRIPE_SECRET_KEY` | `STRIPE_WEBHOOK_SECRET` |
| --- | --- | --- |
| Production | the live key, as now | the live endpoint's secret, as now |
| Deploy Previews | a `sk_test_` key | leave empty — no endpoint can receive for a preview |
| Branch deploys | the same `sk_test_` key | the test endpoint's secret (step 4) |

Scopes: keep whatever the variable has now (it needs *Functions* and
*Runtime*). Then redeploy — Netlify bakes environment variables in at build
time, and nothing changes until the next deploy.

The portal now also refuses a live key outside production
(`usableSecretKey` in `lib/payments/stripe.ts`): Stripe is switched off, with a
logged error. That is the backstop, not the fix; it relies on Netlify exposing
`CONTEXT` at runtime and cannot catch a preview that hides it. Scoping is what
actually keeps a live key out of previews.

**2. Point staging at a throwaway database.** `DATABASE_URL` for *Branch
deploys* must be the Neon branch made for previews (`PREVIEW_DATABASE_URL`),
never production's. The pull-request migration job only migrates pull-request
previews, so apply the migrations to that database yourself:
`npm run db:migrate:remote --workspace apps/platform` with `.env.migrate`
pointing at it.

**3. Create the branch.** `git push origin main:staging`. Confirm under Site
configuration → Build & deploy → Branches and deploy contexts that branch
deploys include `staging`. Its URL is `https://staging--mortensenweb.netlify.app`.

**4. Set up the test account.** Put a test-mode secret key in
`apps/platform/.env.stripe` (no `STRIPE_ALLOW_LIVE_KEY` — this is not the live
account), then:

```bash
npm run stripe:setup --workspace apps/platform -- --portal=https://staging--mortensenweb.netlify.app
npm run stripe:setup --workspace apps/platform -- --portal=https://staging--mortensenweb.netlify.app --apply
```

The first prints a report and changes nothing. The second creates the prices
under their lookup keys in the test account and the webhook endpoint at the
staging URL, and prints the endpoint's signing secret once. Without
`--portal=` the script targets **production's** URL — it will create a webhook
there pointing at the live site, in whichever account the key belongs to.
Put the printed secret in `STRIPE_WEBHOOK_SECRET` for *Branch deploys*, then
redeploy `staging`. Delete `.env.stripe` afterwards.

**5. Run it.** Sign in to staging as an admin (`db:create-admin` against the
staging database), create a client, sign in as them, and pay with the test card
`4242 4242 4242 4242`, any future expiry, any CVC. Then check, in this order:
Stripe dashboard (test mode) → Developers → Webhooks → the staging endpoint
shows the three events answered 200; the client's Billing page lists the
payment; their requests page is open.

**Checking what is set today.** `npm run netlify:stripe-env --workspace apps/platform`
lists the Stripe variables on the portal site, the contexts each is set for,
and the first characters of each key — enough to tell live from test, never a
full value. It reads the Netlify CLI's stored login and changes nothing.

---

## 3. When a check fails

| Symptom | Likely cause |
| --- | --- |
| Welcome page says card payments aren't switched on | `STRIPE_SECRET_KEY` unset, or a live key in a context that isn't production (look for the `[stripe] A live Stripe key is set` line in the log) |
| Payment taken, client still locked | Webhook not reaching the portal: wrong endpoint secret (401), `STRIPE_WEBHOOK_SECRET` set but not redeployed, or the event is `livemode` for the other mode (acknowledged and ignored) |
| Webhook 503 | Missing key or secret in that context |
| Everything 500s after changing a variable | Netlify bakes env in at build time; redeploy |
