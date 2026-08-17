# Setting up Square

Four values the portal needs, plus one per plan. All of them come from two
different Square sites, which is the main thing that makes this confusing:

- **Developer Console** (`developer.squareup.com`) — the application, its
  tokens, and webhooks.
- **Square Dashboard** (`squareup.com/dashboard`) — the actual business:
  locations, items, and subscription plans.

## Do sandbox first

`SQUARE_ENVIRONMENT` defaults to `sandbox`, and the default is deliberate: an
unset value that charged real cards would be a much worse failure than one that
fails to take money. Sandbox needs no bank details and works the moment you have
a developer account.

Sandbox and production have **entirely separate** tokens, location ids,
webhooks, and signature keys. Nothing carries over. Moving to production means
replacing every value below and setting `SQUARE_ENVIRONMENT=production`.

## 1. Create the application

Developer Console → **Applications** → **+** → name it (e.g. `Mortensen Web
Portal`). One application covers both sandbox and production.

## 2. `SQUARE_ACCESS_TOKEN`

Developer Console → your application → **Credentials** in the left pane →
toggle **Sandbox** / **Production** at the top → **Show** → copy.

This is a *personal* access token: unrestricted access to your own Square
account. That is the right choice here — the portal serves one business, yours.
OAuth tokens exist for apps acting on behalf of many different sellers, which is
not what this is.

Treat it like the database password. It goes in Netlify's environment
variables or `.env.local`, never in a command line, a commit, or a chat window.

## 3. `SQUARE_LOCATION_ID`

Developer Console → your application → **Locations**. Sandbox has one created
for you; production lists the real business locations from your Square Dashboard.

Copy the id (it looks like `L9V4KTQ8B7EXAMPLE`). It is not secret — it appears
in ordinary API requests — but it is environment-specific.

## 4. `SQUARE_WEBHOOK_SIGNATURE_KEY` and `SQUARE_WEBHOOK_NOTIFICATION_URL`

**Create the subscription only after `/api/webhooks/square` is deployed.** The
notification URL must be HTTPS and publicly reachable, so `localhost` cannot be
used — webhook testing happens against the deployed portal, or through a tunnel
such as `ngrok` if you want to exercise it locally.

Developer Console → your application → **Webhooks** → **Subscriptions** →
**Add subscription**:

| Field | Value |
| --- | --- |
| Name | `Portal payments` |
| Notification URL | `https://portal.mortensenweb.com/api/webhooks/square` |
| API version | The one matching `SQUARE_VERSION` in `lib/payments/square.ts` |
| Events | see below |

Subscribe to exactly the events the receiver handles — anything else is
acknowledged and dropped, so subscribing more widely only adds noise:

```
payment.created
payment.updated
invoice.payment_made
subscription.created
subscription.updated
```

Save, then reopen the subscription you just created and choose **Show** in the
**Signature Key** box. That is `SQUARE_WEBHOOK_SIGNATURE_KEY`.

### The notification URL must match exactly

Square signs *the notification URL concatenated with the raw request body*, so
`SQUARE_WEBHOOK_NOTIFICATION_URL` has to be byte-identical to what you typed in
the console — scheme, host, path, and trailing slash included.

A mismatch fails every delivery, which is the correct failure. The alternative —
deriving the URL from the incoming request — would let an attacker-controlled
`Host` header decide what we verify against.

## 5. Subscription plans (one variation id per plan)

Only needed for recurring billing. A one-off charge works without any of this.

Square Dashboard → **Items & services** → **Subscription plans** → **Create
plan**. Name it to match a plan in the portal (`Care — Basic`), then **Add
frequency option** — monthly, at the price in `service_plans`.

A plan can have several frequency options, and each one is a separate
**variation**. The portal wants the *variation* id, not the plan id — passing a
plan id produces a checkout that fails in a way the error message does not
explain.

Find it in Developer Console → **Catalog** (or from a `SearchCatalogObjects`
response); it is the `plan_variation_id`. Record it against the matching plan:

```sql
UPDATE service_plans
   SET square_plan_variation_id = '<variation id>'
 WHERE key = 'care-basic';
```

The portal deliberately does not create catalogue objects. Automating a
five-minute task done three times in the business's life would mean carrying the
whole Catalog API to do it.

## Where each value lives

| Value | Secret? | Home |
| --- | --- | --- |
| `SQUARE_ACCESS_TOKEN` | **Yes** | Netlify env var / `.env.local` |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | **Yes** | Netlify env var / `.env.local` |
| `SQUARE_LOCATION_ID` | No | Netlify env var / `.env.local` |
| `SQUARE_WEBHOOK_NOTIFICATION_URL` | No | Netlify env var / `.env.local` |
| `SQUARE_ENVIRONMENT` | No | `sandbox` until you mean it |
| `square_plan_variation_id` | No | `service_plans` row in the database |

Until the first two exist, `isSquareConfigured()` returns false and the portal
says the feature is unavailable rather than failing obscurely. That is designed
behaviour, not a fault.

## Checking it works

Sandbox test card: `4111 1111 1111 1111`, any future expiry, any CVV, any
postcode.

After a sandbox payment, confirm end to end:

1. Developer Console → Webhooks → your subscription → the delivery log shows a
   `2xx`.
2. `webhook_deliveries` has a row with `signature_valid = true`.
3. The matching `payment_requests` row moved to `paid`, with a `payments` row
   beside it.
4. The client's `analytics_unlocked_at` and `change_requests_unlocked_at` are
   set.

A `401` in the delivery log means the signature did not verify — nearly always
`SQUARE_WEBHOOK_NOTIFICATION_URL` differing from what the console holds.

## Sources

- [Access tokens](https://developer.squareup.com/docs/build-basics/access-tokens)
- [Subscribe to event notifications](https://developer.squareup.com/docs/webhooks/step2subscribe)
- [Validate an event notification](https://developer.squareup.com/docs/webhooks/step3validate)
- [Subscription plans and variations](https://developer.squareup.com/docs/subscriptions-api/plans-and-variations)
- [Manage plans in Dashboard](https://squareup.com/help/us/en/article/7627-get-started-with-subscriptions-in-dashboard)
