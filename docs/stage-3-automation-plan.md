# Stage 3 — The operating loop

The business process, written down as a system: prospect → demo → payment →
brief → build → launch → change requests, with agents doing the building and the
operator holding every gate that matters.

This document is subordinate to `stage-0-infrastructure-plan.md`, which remains
authoritative on architecture, tenancy, and security. Where the two disagree,
Stage 0 wins and this file is wrong.

---

## 1. What already exists

Stages 1–2 built more of this than is obvious. Before adding anything, here is
what is already real and tested (116 tests, typecheck clean):

| Capability | State |
| --- | --- |
| ~32-table tenant-aware schema | Built. Covers prospects, concepts, agent jobs, approvals, webhooks, deployments |
| Tenant isolation (branded contexts, 404-not-403) | Built and tested |
| Auth, PBKDF2 600k, lockout, session epoch revocation | Built |
| Client onboarding: username + word temp password, 7-day expiry, forced change | Built |
| Change request submission with image attachments (magic-byte validated) | Built |
| Venmo hand-off, payment requests, ledger, dunning ladder | Built |
| Umami analytics **read** path, never-a-silent-zero states | Built |
| GitHub App auth (WebCrypto, PKCS#1→PKCS#8), REST client, merge/check helpers | Built |
| Issue rendering with prompt-injection containment | Built |
| Dispatch: request → issue → `agent_jobs`, atomic daily quota, watchdog | Built |
| Client repo workflow template (`claude-code-action`, `allowed_bots`) | Built |

The dispatch half of the automation pipeline is done. **The return half is not.**

---

## 2. Gap analysis — the described process, step by step

Each step of the process as described, against what the code can actually do.

### Admin side

| # | Step | Today | Gap |
| --- | --- | --- | --- |
| 1 | Input client into "potential customers", select plan | `prospects` table + read-only list | No create form. No plan on a prospect. Plans have no change allowance |
| 2 | Agent creates a repo and codes a demo reflecting the plan | Tables exist (`concept_jobs`, `concept_repositories`) | No repo creation call. No template contents. No concept dispatch |
| 3 | Demo launches on Netlify | — | Nothing. No Netlify client, no site records, no deploy tracking |
| 4 | After my approval, send the demo to the business | `prospect_shares` (hashed, expiring, revocable), `approvals` | No share route, no approval UI, no send action |
| 5 | Payment received → book a call | Ledger + payment requests built | No prospect→client conversion action |
| 6 | Type wanted features / colour theme into the client's section, submit | — | Nothing. No brief record, no form |
| 7 | Agent applies the brief; demo auto-updates | Dispatch exists for change requests | Briefs have no dispatch path |
| 8 | Send finished site after my approval | — | Same gap as 4 |
| 9 | Email DNS instructions and addresses | Mailer + templates exist | No DNS template, no DNS records stored |
| 10 | Go live, wire Umami, flip tag to active | Umami read path only | No Umami provisioning, no launch action, no status flip |

### Client side

| # | Step | Today | Gap |
| --- | --- | --- | --- |
| 11 | Onboarding email, one-time password, username | **Built** | — |
| 12 | Log in, change password | **Built** | — |
| 13 | Prompted to "unlock analytics" → Square → recurring | — | No Square. No lock state |
| 14 | Payment shows in ledger; analytics + requests unlock | Ledger built | No entitlement gate |
| 15 | Change request: images, description, submit | **Built** | — |
| 16 | Submitting spends one of the month's changes; run out → upgrade or pay per change | — | No allowance, no counter, no overage |
| 17 | Agent updates demo → client gets a link → clicks Apply → goes to the permanent site | Dispatch only | **No webhook receiver. No preview URL. No Apply.** This is the biggest hole |
| 18 | Changes inside half an hour | 30-min watchdog exists | Nothing runs it on a schedule |

### The single most important gap

Step 17. The portal can open an issue and Claude can open a pull request, and
then **nothing happens** — no webhook comes back, no preview URL is captured, the
client is never shown anything, and the request sits on "in progress" until the
watchdog would have failed it. Everything else is additive; this one is a broken
circuit. It is built first.

---

## 3. Design decisions taken here

Six decisions that shape the implementation. Each is a place where the obvious
approach is worse than the chosen one.

### D1 — Preview URLs come from Netlify deploy previews, not a second demo site

"Update the demo site, send them the link, then apply to the permanent site"
describes exactly what a pull request preview deploy already is. Rather than
maintaining a separate long-lived demo site per client and inventing a promotion
mechanism, each change request's preview **is** its PR deploy preview, and
"Apply" **is** the merge. One artifact, one promotion path, no drift between what
the client approved and what ships.

The preview URL is derived from a deterministic alias (`pr-<n>--<site>.netlify.app`)
and then **verified with a real request before the client is shown it**, matching
the existing `noindexVerified` discipline. A URL that 404s is never presented as a
preview.

### D2 — Deploys run from GitHub Actions, not from a Netlify↔GitHub repo link

Linking a repo to Netlify through the API requires the Netlify GitHub App's
per-account `installation_id`, which is only obtainable through their UI OAuth
flow — it cannot be provisioned cleanly from the portal. Deploying from the
client repo's own workflow with the Netlify CLI avoids that entirely and keeps
one place where build behaviour is defined.

Consequence: the site is created via API (`POST /api/v1/sites` with no repo,
which is well-behaved), and the resulting site id is written to the repo as a
GitHub Actions **variable** — plaintext, no encryption needed. `NETLIFY_AUTH_TOKEN`
and `CLAUDE_CODE_OAUTH_TOKEN` stay account-level secrets set once by hand. This
deliberately avoids adding a libsodium dependency purely to seal repo secrets.

### D3 — Entitlements are explicit columns, not a derived query

Analytics and change requests unlock on the first confirmed payment. That could
be derived (`EXISTS (SELECT … FROM payments)`), but derived access control is
access control you cannot audit, cannot grant by hand for a client whose payment
arrived by cash, and cannot revoke without deleting ledger rows. Two timestamps
on `clients` — set by the same code path that confirms a payment, recorded in
`audit_log` — are simpler and honest.

### D4 — Allowance consumption is atomic, using the pattern already proven

`claimDispatchSlot` already solves "increment a counter and refuse past a cap,
under concurrency" in a single statement with `setWhere`. Change allowances are
the same problem — two submissions a few milliseconds apart must not both spend
the last change — so they use the same pattern rather than a read-then-write.

### D5 — Square is a driver behind a narrow interface, and recurring stays operator-visible

Verified against Square's docs: `POST /v2/online-checkout/payment-links` creates a
hosted checkout; subscription checkout requires a subscription **plan variation**
id plus `price_money`; webhooks are `x-square-hmacsha256-signature`, HMAC-SHA256
over *notification URL + raw body*, base64, compared in constant time.

What is deliberately **not** automated: creating catalogue subscription plans.
That is a one-time setup done in the Square dashboard, and the variation id is
configuration. Generating catalogue objects from the portal adds a large API
surface to save a five-minute task done once per plan.

The gap between "client pressed pay" and "money arrived" stays modelled exactly
as Venmo already models it (`awaiting_confirmation`), because a webhook can be
late or lost. Square's webhook *narrows* that gap; it does not remove the state.

### D6 — A brief is a first-class record, not a note

"Type what they want into a text box and click submit" could be a client note. It
is not, because that text becomes an agent's instructions and therefore needs a
status, a dispatch record, an audit trail, and a link to the job it produced.
`site_briefs` carries structured fields (colour direction, features, content
notes) plus free text, and dispatches through the *same* injection-contained
issue renderer as client change requests — the operator's own words get no
special trust, because a brief repeats what a third party said on a call.

---

## 4. Schema additions (migration 0004)

| Table | Change | Why |
| --- | --- | --- |
| `service_plans` | `included_changes_per_month`, `overage_per_change_cents`, `includes_analytics`, `sort_order` | Plans must encode what a plan *is* |
| `prospects` | `plan_id` | Step 1: pick the plan at intake |
| `clients` | `analytics_unlocked_at`, `change_requests_unlocked_at` | D3 |
| `change_allowances` | new: client, period, `included`, `used` | D4 |
| `change_requests` | `billing` enum, `allowance_id`, `payment_request_id`, `preview_url`, `client_decision*` | Overage + Apply |
| `site_briefs` | new | D6 |
| `agent_jobs` | `preview_url`, `preview_verified_at`, `brief_id` | D1 |
| `preview_deployments` | `agent_job_id`, `kind`, `pr_number` | D1 |
| `sites` | `netlify_site_id`, `netlify_site_name`, `production_url`, `dns_records`, `dns_sent_at`, `live_verified_at` | Steps 3, 9, 10 |
| `subscriptions` | `provider`, `provider_subscription_id`, `recurring_enabled_at` | D5 |
| `payment_requests` | `provider`, `provider_reference`, `checkout_url` | D5 |
| enums | `payment_method += square`; new `billing_treatment`, `brief_status`, `brief_kind`, `preview_kind` | — |

---

## 5. Build order

Vertical slices, each one leaving the tree green.

1. **Schema + migration 0004** — everything below depends on it
2. **Netlify client** — create site, read deploys, verify a URL is live
3. **GitHub webhook receiver** — closes the circuit (the step-17 hole)
4. **Preview capture + client Apply + merge guards** — the loop the client sees
5. **Entitlements + allowances** — the commercial gate
6. **Square driver + checkout + webhook** — how money arrives
7. **Prospect → concept → demo → share** — the acquisition funnel
8. **Brief intake + dispatch** — the post-call step
9. **Launch: Umami provisioning, DNS email, go-live** — the handoff
10. **Scheduled jobs** — dunning, watchdog, allowance rollover, preview expiry
11. **Repo template + deploy workflows** — what gets scaffolded
12. **Tests throughout**

---

## 6. What stays manual, on purpose

Not everything in the described process should be automated, and two things
specifically should not be:

- **Nothing is ever sent to a prospect or client without an explicit approval
  click.** The process says "automatically send after approval from me" — the
  approval is the automation boundary, and it is recorded in `approvals` with a
  named user and a timestamp. Stage 0 §7.2's prohibition on automated prospect
  contact is preserved: there is still no code path that emails a prospect
  without an operator decision.
- **Confirming that money arrived stays a human act** for off-platform rails.
  Square's webhook automates it for Square; Venmo and cash do not get a shortcut.

And one thing that is a genuine trade-off worth naming: the half-hour target for
changes is achievable for content edits that merge automatically, and is **not**
achievable for structural changes that need review. The client-facing copy
should promise the former and not the latter.
