# Stage 0 — Infrastructure Plan (Plan Only, No External Changes)

**Status:** Awaiting approval. Nothing external has been created, modified, or read.
**Date:** 2026-08-14
**Working directory:** `C:\Users\cjack\OneDrive\Desktop\Organization\Claude Projects\WebsiteBusiness`

---

## 0. Working-directory safety check

| Check | Result |
| --- | --- |
| Directory exists | Yes |
| Entry count (top level, `-Force`, non-recursive) | **0 — empty** |
| `git rev-parse --show-toplevel` | Exit 128 — not inside a repository |
| Ancestor `.git` probe (existence only, no reads) | None found in any ancestor up to drive root |
| Files read | None |
| Directories crawled recursively | None |

**Verdict: safe to proceed.** This is a new, empty folder outside any repository.

The only filesystem operations performed were a single non-recursive name listing of this
directory and a `.git` existence probe on ancestor paths. No file contents were read, no
repository was opened, and no directory outside this path was enumerated.

---

## 1. Verified stack findings (research performed before planning)

These were checked against current official documentation rather than assumed. Two of them
change the recommended design.

### 1.1 Cloudflare + Next.js — `next-on-pages` is superseded

`@cloudflare/next-on-pages` has been superseded. The current official path is
**`@opennextjs/cloudflare`** deploying to **Cloudflare Workers** (not Pages).

| Aspect | `@cloudflare/next-on-pages` (old) | `@opennextjs/cloudflare` (current) |
| --- | --- | --- |
| Target | Cloudflare Pages | Cloudflare Workers |
| Next.js runtime | Edge only | **Node.js runtime** |
| Next.js versions | Limited | 15, 16 (14 support dropped Q1 2026) |
| Status | Superseded | Recommended by Cloudflare |

Requirements: `nodejs_compat` compatibility flag, compatibility date `2024-09-23` or later,
`main: ".open-next/worker.js"` in `wrangler.jsonc`, and an `open-next.config.ts`.
`export const runtime = "edge"` must **not** appear anywhere — the adapter does not support it.

This satisfies the prompt's instruction to document the replacement rather than silently
switching. We stay on Cloudflare; we do not move to Vercel.

### 1.2 Workers Free tier CPU limit is a hard blocker — **decision required**

| Plan | CPU per invocation | Requests |
| --- | --- | --- |
| Workers **Free** | **10 ms** | 100,000/day |
| Workers **Paid** ($5/mo) | 30 s default, up to 5 min | 10M/mo included |

**10 ms of CPU cannot support this platform.** Two independent reasons:

1. **Password hashing.** Workers has no native bcrypt or Argon2. The only natively supported
   KDF is **PBKDF2 via Web Crypto**. PBKDF2-HMAC-SHA-256 at the OWASP-recommended 600,000
   iterations costs on the order of hundreds of milliseconds of CPU. Argon2id via WASM costs
   more. Neither fits in 10 ms. Reducing iterations far enough to fit would produce password
   storage weak enough that it is not worth shipping.
2. **Next.js SSR.** A React server-render of a dashboard page routinely exceeds 10 ms CPU on
   its own, before any hashing.

Splitting hashing into a second Worker behind a service binding does **not** help — the 10 ms
limit applies per Worker invocation, so the child Worker hits the same wall.

**Recommendation: Cloudflare Workers Paid, $5/month.** This is the platform's only required
recurring cost and it is not a "silent switch to a paid dependency" — it is surfaced here as an
explicit approval item. At $5/mo with 30M CPU-ms included, a portal at this scale will not
exceed the included allowance.

If you decline the $5/mo, the honest alternatives are: (a) move authentication off Workers to a
Node host, which fragments the architecture; or (b) ship weakened password hashing, which I do
not recommend and will not do without you overriding this in writing.

### 1.3 Claude Code GitHub Actions — supported, with two gotchas

Officially supported as `anthropics/claude-code-action@v1`. Confirmed capabilities:

- **Interactive mode** (no `prompt` input): responds to `@claude` mentions.
- **Automation mode** (`prompt` input supplied): runs on any GitHub event without a mention —
  this is the mode our portal uses.
- Can create branches, push commits, and open pull requests.

**Gotcha A — bot actors are rejected by default.** The action runs two checks on the triggering
actor: the actor must have write access, *and* the action **rejects bot actors** unless listed
in `allowed_bots`. Our portal opens issues through a GitHub App, so the triggering actor is a
bot and **every run would fail** unless each client repo's workflow lists our app's actor login
in `allowed_bots`. This applies to `workflow_dispatch` too, so it cannot be dodged by changing
the trigger. This must be baked into the client-repo workflow template from day one.

**Gotcha B — `CLAUDE_CODE_OAUTH_TOKEN` is the wrong credential for this use case.** It is
officially supported (Pro, Max, Team, Enterprise; generated with `claude setup-token`), but the
documentation explicitly states that for a secret shared across repositories you should use a
**Console API key rather than an OAuth token, because the OAuth token is tied to the personal
subscription of whoever generated it**. For unattended commercial work across many client
repositories, that is the wrong coupling: billing and identity would run through your personal
subscription for client work.

**Recommendation, in preference order:**

1. **Workload identity federation (OIDC)** — the action exchanges the workflow's GitHub OIDC
   token for Claude API access via a Console service account. No long-lived secret stored
   anywhere. Requires `id-token: write` and Console-side setup
   (`anthropic_federation_rule_id`, `anthropic_organization_id`).
2. **Console API key as an organization-level Actions secret** — simple, correct billing,
   one secret to rotate.
3. ~~Personal OAuth token~~ — not recommended for commercial multi-client automation.

Either way, the credential lives **only** in GitHub Actions secrets. It is never stored in the
portal database, never in application code, and never in an environment variable the portal
reads.

Also noted: GitHub does not trigger downstream workflows on commits made with the default
`GITHUB_TOKEN`, so the workflow must authenticate as the GitHub App for our CI checks to run on
Claude's commits.

### 1.4 Verified free-tier numbers

| Service | Free allowance (verified) | Binding constraint for us |
| --- | --- | --- |
| **Cloudflare Workers** | 100k req/day, **10 ms CPU/invocation** | CPU — see §1.2 |
| **Cloudflare R2** | **10 GB** storage, 1M Class A ops, 10M Class B ops, **zero egress** | Comfortable |
| **Neon Postgres** | 100 projects, 10 branches/project, **0.5 GB storage/project**, **100 CU-h/project/mo**, 5 GB transfer/project/mo, scale-to-zero after 5 min | Storage, for Umami only |
| **Resend** | **3,000 emails/month**, **1 domain per team** | Fine at this scale |
| **GitHub Actions** | Private repos consume included minutes (2,000/mo Free) | Claude runs on private client repos draw down these minutes |
| **Umami (self-host)** | Needs Node ≥18.18 + Postgres ≥12.14 | Cannot run on Workers — needs its own host |

### 1.5 Auth.js v5

Auth.js v5 (`next-auth@5`) is current. The Credentials provider with **JWT session strategy** is
the edge-compatible combination; database adapters are not edge-safe and must be kept out of
middleware. Because OpenNext puts us on the **Node.js runtime**, this is materially less painful
than the classic edge split — but middleware still gets a slim, adapter-free config.

---

## 2. Proposed system architecture

```
                          ┌──────────────────────────────┐
   Public visitors  ─────▶│  agency-portfolio            │  <agency-domain>
                          │  Next.js / OpenNext / Workers│  mostly static, ISR
                          └──────────────┬───────────────┘
                                         │ contact form (server action)
                                         ▼
                          ┌──────────────────────────────┐
   Admin + clients  ─────▶│  agency-platform             │  portal.<agency-domain>
                          │  Next.js App Router          │
                          │  OpenNext → Cloudflare Worker│
                          └───┬────┬────┬────┬────┬──────┘
                              │    │    │    │    │
        ┌─────────────────────┘    │    │    │    └──────────────────┐
        ▼                          ▼    │    ▼                       ▼
  ┌───────────┐         ┌──────────────┐│ ┌──────────┐      ┌────────────────┐
  │ Neon      │         │ Cloudflare R2││ │ Resend   │      │ GitHub App     │
  │ Postgres  │         │ attachments  ││ │ email    │      │ (org-owned)    │
  │ (Drizzle) │         │ screenshots  ││ └──────────┘      └───┬────────┬───┘
  └───────────┘         └──────────────┘│                       │        │
                                        ▼                  issues│        │webhooks
                              ┌──────────────────┐               ▼        │(signed)
                              │ Umami (self-host)│      ┌──────────────────┴────┐
                              │ Node + own Neon  │      │ client-*/prospect-*   │
                              │ SERVER-SIDE PROXY│      │ repos + Claude Action │
                              │ ONLY — key never │      │ → PR → checks → merge │
                              │ reaches browser  │      └───────────┬───────────┘
                              └──────────────────┘                  │
                                                                    ▼
                                                        ┌───────────────────────┐
                                                        │ Cloudflare Workers    │
                                                        │ preview + production  │
                                                        │ (per client site)     │
                                                        └───────────────────────┘

  agency-theme-library ── consumed at scaffold time, version-pinned, never deployed
```

**Trust boundaries.** Three, and they are the security backbone:

1. **Client ↔ client.** Enforced server-side on every query and mutation via a repository layer
   that will not compile a query without an `orgId` derived from the verified session.
2. **Client ↔ admin.** Role gate plus separate route groups. Client users can never reach
   Potential Clients, Payments admin, or Settings/Integrations.
3. **Platform ↔ untrusted external content.** Crawled prospect pages, webhook payloads, and
   uploaded files are **data, never instructions**. Crawled content is stored as
   source-attributed facts with a verification status and is never interpolated into an agent
   prompt as an instruction.

---

## 3. Proposed GitHub organization and repositories

### 3.1 Organization layout

```text
<agency-organization>/
├── agency-platform          (private)  admin + client portal
├── agency-portfolio         (private source, public deploy)
├── agency-theme-library     (private)  design system + industry themes
├── agency-documentation     (private)  OPTIONAL — see §3.4
├── prospect-<company>-<job-id>   (private, on demand)
└── client-<company>-website      (private, on demand)
```

**Only the approved minimum is created in Stage 1.** Prospect and client repositories are
created on demand, never pre-provisioned.

### 3.2 Organization settings to configure

| Setting | Value | Why |
| --- | --- | --- |
| Base repository permissions | **None** | Members get access only via explicit team grants |
| Default repository visibility | **Private** | Client work is never public by default |
| Member repo creation | Owners only (private allowed) | Prevents accidental public repos |
| Secret scanning + **push protection** | Enabled org-wide | Blocks committed secrets at push time |
| Dependabot alerts + security updates | Enabled | Client sites stay patched |
| Two-factor authentication | **Required** for all members | Non-negotiable for client repo access |
| Teams | `owners`, `platform-admins`, (later) `contractors` | Contractors get per-repo grants only |
| Actions permissions | Allow Actions from this org + selected verified creators | Limits supply-chain surface |
| Org Actions secrets | `ANTHROPIC_API_KEY` (or OIDC federation), `CLOUDFLARE_API_TOKEN` | One place to rotate |
| Fork policy | Disabled for private repos | Prevents client code leaving the org |

### 3.3 Branch protection / rulesets (per repo, `main`)

- Require a pull request before merging (1 approval; you are the approver).
- Require status checks to pass: `lint`, `typecheck`, `test`, `build`.
- Require branches to be up to date before merging.
- **Block force pushes.**
- **Block deletion** of `main`.
- Require conversation resolution.
- Do **not** allow bypass for the Claude app — its PRs go through the same gates.

### 3.4 Repository-by-repository

**`agency-platform`** (private) — the portal. Next.js App Router, Drizzle schema + migrations,
API routes, GitHub App integration, webhook receiver, payments, analytics proxy, notifications,
PWA.

**`agency-portfolio`** (private source, public deployment) — marketing site. Source stays
private so unreleased case studies and client names aren't visible in Git history; only the
built site is public.

**`agency-theme-library`** (private) — design tokens, primitives, industry themes, content
schemas, generator, examples, screenshot tests. **Generic data only** during the infrastructure
phase.

**`agency-documentation`** — **recommendation: do not create it yet.** Splitting docs from code
guarantees drift, and there is no security benefit while you are the only operator (the platform
repo is already private). Keep runbooks in `agency-platform/docs/`. Revisit when you add
contractors who need runbooks without code access. *(Your call — this is decision D7.)*

### 3.5 Per-repository creation checklist (Stage 1)

For each repo, in order:

1. Confirm exact owner and name with you.
2. Check name availability by direct lookup of that one name — **no listing of your repositories**.
3. Create as **private**.
4. Add `.gitignore` (Node + Next.js + wrangler + env + OS).
5. Add `.env.example` — **variable names and comments only, never values**.
6. Add `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `docs/architecture.md`.
7. Scan staged content for secret-shaped strings before the first commit.
8. `git init` deliberately, `main` as default branch.
9. Initial commit, push `main`.
10. Verify visibility is private and the commit landed.
11. Apply ruleset/branch protection.

Never overwrite an existing repository, re-init its history, force-push, or commit a real secret.

---

## 4. Database model

PostgreSQL on Neon, Drizzle ORM, versioned migrations in `drizzle/`. Every table gets
`created_at`/`updated_at`. Every externally referenced row gets a **non-guessable `public_id`**
(128-bit random, base58, 22 chars). Internal integer/UUID keys are never exposed in URLs or APIs.

### 4.1 Identity and organizations

| Table | Key columns |
| --- | --- |
| `users` | `public_id`, `email` (citext unique), `password_hash`, `password_algo`, `password_updated_at`, `must_change_password`, `role` ∈ {admin, client}, `status` ∈ {invited, active, disabled}, `session_epoch` int, `failed_login_count`, `locked_until`, `last_login_at` |
| `organizations` | `public_id`, `name`, `slug` unique, `kind` ∈ {agency, client}, `status`, `timezone`, `archived_at` |
| `organization_memberships` | `org_id`, `user_id`, `role` ∈ {owner, member}, unique(`org_id`,`user_id`) |
| `password_reset_tokens` | `user_id`, **`token_hash`** (SHA-256; raw token never stored), `expires_at`, `used_at`, `requested_ip_hash` |
| `email_verification_tokens` | same shape |
| `login_attempts` | `email_hash`, `ip_hash`, `succeeded`, `created_at` — feeds rate limiting |
| `impersonation_sessions` | `admin_user_id`, `target_user_id`, `target_org_id`, `started_at`, `ended_at`, `reason` — "View as client" audit |
| `audit_log` | `actor_user_id`, `action`, `entity_type`, `entity_id`, `metadata` jsonb, `ip_hash` |

`session_epoch` is the session-revocation mechanism: it is embedded in the JWT and compared to
the DB value on every authenticated request. Disabling an account, changing a password, or
ending impersonation increments it, invalidating every outstanding token immediately.

### 4.2 Sites and repositories

| Table | Key columns |
| --- | --- |
| `sites` | `public_id`, `org_id`, `name`, `primary_domain`, `status` ∈ {draft, preview, live, archived}, `theme_key`, `theme_version`, `launch_approved_at`, `launch_approved_by` |
| `site_environments` | `site_id`, `kind` ∈ {preview, production}, `url`, **`is_indexable` default false**, `cf_worker_name`, `last_verified_at` |
| `repository_connections` | `site_id`, `owner`, `name`, **`repo_node_id`**, `installation_id`, `default_branch`, `connection_mode` ∈ {managed, connected_existing, transferred}, `allowlisted` bool, `verified_at`, unique(`owner`,`name`) |
| `deployments` | `site_id`, `environment_id`, `external_id`, `commit_sha`, `status`, `url`, `is_rollback`, `rolled_back_from_id` |
| `analytics_connections` | `site_id`, `umami_website_id`, `status`, `last_synced_at` |
| `automation_readiness_checks` | `site_id`, `check_key`, `status` ∈ {pass, warn, fail, unknown}, `detail` jsonb, `checked_at` |

`repo_node_id` (not `owner/name`) is the webhook allowlist key — names can be changed by a
third party, node IDs cannot.

### 4.3 Current clients

`clients`, `service_plans`, `subscriptions`, `payments`, `payment_adjustments`, `client_notes`,
`migration_projects`, `migration_tasks`, `migration_audits`.

- `organizations` is the **tenancy** boundary; `clients` is the **commercial** record. Keeping
  them separate means billing changes never touch access control.
- `payments` carries `provider`, `provider_reference`, and a nullable unique `idempotency_key`
  so Stripe can be added later without a migration of intent.
- **Payments are never deleted.** Corrections go through `payment_adjustments`
  (`correction | refund | void | writeoff`) with a reason and an author. The ledger is append-only.
- `client_notes.visibility` ∈ {`internal`, `client_visible`} — defaults to `internal`, and the
  client-facing query filters on it at the repository layer, not in the view.
- `migration_projects` stores your verbatim `authorization_text`, `authorized_by_user_id`,
  `authorized_at`, and a `scope` ∈ {`read_only_audit`, `branch_changes`, `launch`}. **Scope is
  enforced in code**, not by convention: with scope `read_only_audit`, no write path to that
  repository is reachable.
- `migration_audits.secret_findings` stores **counts, rule names, and file paths only — never
  the matched values**.

### 4.4 Potential clients

`prospects`, `prospect_contacts`, `site_audit_jobs`, `audited_pages`, `business_facts`,
`concept_jobs`, `concept_repositories`, `preview_deployments`, `screenshots`,
`prospect_shares`, `prospect_conversions`.

- `business_facts` is the heart of the anti-hallucination design:
  `key`, `value`, `source_url`, `source_type` ∈ {crawl, user_supplied, inferred},
  `verification` ∈ {unverified, user_verified, conflicting, **sensitive**}, `confidence`.
  **Only `user_verified` and `user_supplied` facts may be rendered into a generated site.**
  Everything else renders as an explicit placeholder. This is what stops a concept site from
  publishing a licence number, a price, or a guarantee that the crawler merely guessed at.
- `sensitive` flags claims that must never be auto-published: licence/insurance numbers,
  certifications, warranty terms, pricing, award claims, staff names.
- `prospect_shares` uses a hashed token with an expiry and a revocation timestamp — share links
  are revocable and never permanent.

### 4.5 Change operations

`change_requests`, `request_attachments`, `request_events`, `approvals`, `agent_jobs`,
`webhook_deliveries`, `dispatch_quotas`, `notifications`.

- `change_requests.status` is a **controlled state machine**, enforced by a transition table
  rather than free assignment:

```
submitted → triaged → approved → dispatched → in_progress
          ↘ rejected                        ↘ failed → triaged
                                   in_progress → pr_open → merged → deployed → verified → closed
                                                        ↘ changes_requested → in_progress
                                              deployed → rolled_back → triaged
```

- `request_events.visibility` ∈ {`internal`, `client_visible`} — internal agent logs and
  client-visible comments live in one timeline table but are filtered server-side. The client
  timeline query is a distinct repository method that hard-codes `visibility = 'client_visible'`.
- `webhook_deliveries.delivery_id` is **unique** — that unique index *is* the idempotency
  mechanism. A duplicate delivery fails the insert and is acknowledged without reprocessing.
- `notifications.dedupe_key` unique — prevents duplicate emails on webhook retries.
- `dispatch_quotas` — unique(`day`, `scope`), default cap **10/day**, configurable globally and
  per repository.

### 4.6 Integrity rules applied throughout

- Foreign keys everywhere, with deliberate `ON DELETE` policy (mostly `RESTRICT`; audit tables
  `SET NULL` on actor so history survives user deletion).
- Indexes on every tenant-scoped access path: `(org_id, created_at)`, `(site_id, status)`,
  `(public_id)` unique.
- `CHECK` constraints on money (`amount_cents >= 0`), date ranges
  (`covers_period_end >= covers_period_start`), and enum-like text columns.
- Soft deletion via `archived_at`; hard deletion reserved for a documented purge routine.
- **No client can reach another client's record by guessing an ID** — `public_id` is 128-bit
  random *and* every lookup is additionally scoped by `org_id`. Guessing is not the only
  barrier; it is the second barrier.

---

## 5. Authentication and tenant isolation

### 5.1 Mechanism

- **Auth.js v5**, Credentials provider, **JWT session strategy**.
- **Hashing: PBKDF2-HMAC-SHA-256, 600,000 iterations, 16-byte random salt, 32-byte output**,
  via Web Crypto `crypto.subtle` (native on Workers). Stored PHC-style:
  `$pbkdf2-sha256$i=600000$<salt_b64>$<hash_b64>`, with the algorithm recorded in
  `password_algo`. Verification is constant-time. On successful login, if the stored parameters
  differ from current policy, the password is transparently rehashed.
  *Rationale: Workers has no native bcrypt/Argon2; PBKDF2 via Web Crypto is the only natively
  supported KDF and runs in optimized native code. The PHC-style prefix and `password_algo`
  column mean we can migrate to Argon2id later without a flag day. Requires Workers Paid (§1.2).*
- **Cookies:** `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`.
  Admin sessions 8 h; client sessions 24 h; rolling refresh on activity.
- **Rate limiting:** per-IP and per-account sliding window backed by `login_attempts`, plus
  account lockout (`locked_until`) with exponential backoff. Failures are generic — the response
  never reveals whether an email exists.
- **Password reset:** single-use token, only its SHA-256 stored, 30-minute expiry, invalidated
  on use and on password change. Response is identical whether or not the email exists.
- **Forced temporary-password change:** `must_change_password` gates *all* routes in middleware
  except `/change-password` and `/api/auth/*`.
- **Revocation:** `session_epoch`, as described in §4.1.
- Magic link is deliberately deferred to post-launch.

### 5.2 Tenant isolation — the enforcement design

The rule: **no client-facing database access happens outside a repository layer that requires a
tenant context object**, and that context can only be constructed from a verified session.

```ts
// Constructible only from a verified session — never from a request parameter.
type TenantContext = { userId: string; orgId: string; role: 'admin' | 'client' };

// Client-facing repositories take it as a required first argument.
listChangeRequests(ctx: TenantContext, filter): Promise<ChangeRequest[]>
// → every generated query carries `where org_id = ctx.orgId`
```

Admin-only repositories are a **separate module** that takes an `AdminContext`, so a client
route physically cannot import a cross-tenant query. This is a structural guarantee, not a
code-review convention.

**Cross-tenant tests are mandatory and blocking.** For every client-visible route and mutation,
a test asserts that a user in org B requesting org A's `public_id` receives **404, not 403** —
403 confirms the resource exists, which is itself a leak.

Postgres row-level security is evaluated as **defense in depth in Stage 8**, not as the primary
control. The Neon HTTP driver is stateless, so `SET LOCAL app.org_id` requires the WebSocket
driver and a transaction per request. Documented as a Stage 8 decision with that trade-off.

---

## 6. Current Clients workflow

Built with **clearly labeled demo data only**. No real client enters this system until you
authorize a migration in writing.

### 6.1 List view

Columns: client name · primary contact · site/domain · plan + monthly price · payment status
(paid-through date) · site status · repo connection · analytics connection · automation
readiness · open requests · migration status.
Filterable on status, plan, payment status, migration state, automation readiness; searchable by
name and domain.

### 6.2 Flow A — new client, new website repository

1. Create organization (tenancy) + client (commercial) records.
2. Create or invite the client user (temporary password, `must_change_password = true`).
3. Create the site record — status `draft`.
4. Select industry and an approved theme + variant; **pin `theme_version`**.
5. Confirm repository owner and exact name with you.
6. Create private `client-<company>-website` in the org.
7. Scaffold from the pinned theme version; write `theme.lock.json`.
8. Configure preview deployment (non-production Worker).
9. **Production launch stays disabled** until an explicit `production_launch` approval row exists.

### 6.3 Flow B — import an existing client (deliberately gated)

1. Create a migration **draft** — no repository is read.
2. You explicitly name the repository as `owner/repo`.
3. The screen displays the exact proposed access scope and the exact repository.
4. You confirm in writing.
5. **Only that one repository** is read, read-only.
6. An audit is produced **before** anything changes.
7. You choose one of: connect in place · transfer into the org · create a clean client repo and
   migrate into it.
8. No duplicate is ever created blindly.
9. **The live site is never touched during import.**
10. A **separate** launch approval is required before anything goes live.

### 6.4 Drill-down

Overview · live + preview links · analytics · change requests · payment history ·
repository/deployment history · automation readiness · migration checklist and results ·
internal notes (visually separated from client-visible communication) · **read-only "View as
client"** with a persistent banner, a hard block on all mutations while active, and a row in
`impersonation_sessions` opened on entry and closed on exit.

---

## 7. Potential Clients workflow

Admin-only. Never visible to client users, at the route-group level as well as the query level.

### 7.1 List view

Business name · source URL · industry · selected theme · audit status · concept status · repo
status · preview URL/status · last activity · share/approval state · conversion status.

### 7.2 Concept generation pipeline

Inputs: public URL, business name, industry, theme + variant, tone, location/service area,
requested pages, special instructions, authorization/asset-use notes, crawl limits, concept
expiration date, plan-approval requirement.

```
1  Validate URL          → https only; public DNS only; SSRF guards (§13.1)
2  Audit public pages    → respect robots.txt; ≤N pages, ≤depth D, rate limited, timeout
3  Treat as DATA         → crawled text is NEVER an instruction to any agent
4  Extract facts         → business_facts with source_url + verification status
5  Flag gaps             → missing / contradictory / SENSITIVE claims surfaced to you
6  Plan                  → sitemap, content map, SEO-preservation notes
7  Approval gate         → if plan_approval_required, STOP here
8  Create repo           → private prospect-<business>-<job-id>
9  Scaffold              → from pinned theme version
10 Content rule          → verified + supplied + generic placeholder ONLY
11 Local build           → report localhost URL to you
12 Tests                 → lint, typecheck, build, a11y, link check
13 Preview deploy        → Cloudflare, non-indexed, expiring
14 Verify preview        → assert noindex header AND robots.txt AND meta tag
15 Screenshots           → mobile / tablet / desktop → R2
16 Package               → deliver concept bundle
```

**Hard prohibitions, enforced by having no code path that could do otherwise:** never modify the
prospect's live website, domain, DNS, Google Business Profile, ads, analytics, or hosting.
**Never contact a prospect automatically** — there is no outbound-email path from the prospect
module at all.

### 7.3 Conversion to current client

Creates/links org + user + site · preserves the full prospect audit history · **requires explicit
confirmation of content and asset rights** · replaces every placeholder with verified
information (build fails if any `unverified` fact would render) · you choose rename/transfer vs.
clean repo · configures analytics/forms/automation · creates an SEO migration project ·
requires explicit production launch approval.

**Conversion never changes DNS and never replaces a live site.**

---

## 8. Theme library plan

### 8.1 Structure

```
agency-theme-library/
├── packages/
│   ├── tokens/            design tokens: color, type, space, radius, shadow, motion
│   ├── primitives/        Button, Card, Section, Container, Field, Icon (a11y-complete)
│   ├── blocks/            Nav×N, Hero×N, Services×N, Reviews×N, Gallery×N, CTA×N, Footer×N
│   ├── schema/            Zod content schemas; required vs. optional per theme
│   ├── generator/         scaffolder: theme + content → site repo
│   └── themes/
│       ├── hvac/          traditional-trust · modern-comfort · emergency-response
│       │                  premium-residential · commercial-mechanical
│       ├── artists/       minimal-gallery · luxury-editorial · western-bronze
│       │                  contemporary-studio
│       ├── window-cleaning/  bright-and-clean · residential-friendly · commercial-glass
│       └── car-detailing/    dark-luxury · performance · clean-premium
├── examples/              one generic demo business per variant
└── tests/                 schema, a11y, visual regression, compatibility matrix
```

Extension paths prepared (not built) for plumbing, roofing, landscaping, carpet cleaning,
construction, professional services, restaurants, local retail, nonprofits,
engineering/technology.

### 8.2 Every theme defines

Design tokens · typography + palettes · spacing/borders/shadows/buttons · navigation variants ·
hero variants · service layouts · review layouts · galleries · CTA + footer variants · industry
modules · page/content schema · required vs. optional data · accessibility rules · mobile
behavior · image rules · SEO recommendations · **appropriate and inappropriate uses**.

### 8.3 Avoiding the clone problem

Variation is structural, not cosmetic. Each variant selects independently across nav layout,
hero composition, section order, service card shape, review presentation, type pairing, palette
role assignment, and image treatment. A **compatibility matrix** (tested in CI) records which
blocks may combine, so the generator can vary freely inside proven-good combinations and never
produces a broken or visually incoherent pairing.

### 8.4 Versioning — the critical safety property

Every generated site is pinned to an exact theme version at scaffold time:

```json
// theme.lock.json in every generated site repo
{ "theme": "hvac/modern-comfort", "version": "1.4.2", "sourceCommit": "a1b2c3d…",
  "generatedAt": "2026-08-14T…", "generator": "1.0.0" }
```

**A theme update can never silently change a deployed client site.** Upgrading a site is an
explicit, reviewed, per-site pull request.

**Distribution — decision D6.** Two options:

- **(A) Vendor at scaffold time (recommended).** The generated repo contains real component
  source. Self-contained; survives the theme library disappearing; and critically, **Claude Code
  working inside a client repo can edit actual components** rather than being blocked by an
  opaque `node_modules` dependency — which is the whole point of the automation pipeline.
  Trade-off: upstream fixes need a propagation PR per site.
- **(B) Private npm via GitHub Packages.** Fixes propagate by version bump. Trade-off: the
  automation pipeline's usefulness drops sharply, because most change requests ("move the phone
  number", "change this section") land inside the dependency where Claude cannot edit.

**Recommendation: (A), with a `theme-upgrade` command that opens propagation PRs across sites.**
This keeps the automation pipeline effective, which is the platform's main value.

---

## 9. Public agency portfolio

Contains at setup: value proposition · services · website creation process · rapid update +
analytics services · theme previews using **generic demo businesses** · contact/qualification
form · portfolio in an **empty or explicitly-labeled demo state**.

Data model prepared now, populated later: industry tags · visual-style tags · feature tags ·
case studies · screenshots · live links · results/testimonials · **`publicDisplayApproved`**.

**Query-level guarantee:** the public portfolio query hard-filters `publicDisplayApproved = true`
in the repository method itself. No real client appears until explicitly migrated *and* approved
for public display — approval is a stored decision, not a config toggle.

---

## 10. Analytics

Umami requires Node ≥ 18.18 and Postgres ≥ 12.14 — it **cannot run on Cloudflare Workers**, so it
needs its own always-on host.

**D5 settled: start on Umami Cloud Hobby (free), self-host on a VPS later.** Two findings ruled
out the free self-hosting options I originally suggested:

**Finding 1 — free spin-down hosts lose analytics events.** Render's free tier spins a service
down after 15 minutes without traffic and takes about a minute to cold-start. Umami's tracker
endpoint and its dashboard are the *same* service, so a sleeping instance drops or badly delays
incoming pageview beacons. Local service-business sites have exactly the low, bursty traffic that
keeps such a host asleep almost permanently — we would lose a large share of events, which
defeats the purpose, since analytics is part of what the agency sells.

**Finding 2 — Umami on Neon free exhausts the compute quota.** This contradicts my own earlier
recommendation. Neon's free plan allows **100 CU-hours per project per month** and relies on
scale-to-zero after 5 minutes idle to stay under it. A self-hosted Umami holds a persistent
connection pool, which prevents scale-to-zero. At Neon's 0.25 CU floor, continuous operation
costs 0.25 × 730 h ≈ **182 CU-hours/month — roughly 1.8× the entire free allowance**, exhausting
it in about two and a half weeks. The fix when self-hosting is to run **Postgres in Docker on the
same VPS as Umami**, not on Neon free. Portal data stays on Neon, where scale-to-zero works
normally.

Because the portal reaches Umami **only** through the server-side proxy, moving from Umami Cloud
to self-hosted later is a base-URL and API-key change, not a rewrite. Nothing in the portal
depends on which one is in use.

- **Server-side proxy only.** The Umami API key exists solely as a Worker secret. It is never
  sent to the browser, never in a client component, never in a public env var.
- One Umami website ID per site, stored in `analytics_connections`.
- 7 / 30 / 90-day views: pageviews, visitors, top pages, referrers, devices, countries.
- Conversion events where configured.
- Cached aggregates with a visible **last-updated** timestamp.
- Explicit empty and error states — never a silent zero, which reads as "no traffic" when it
  actually means "the API is down".
- **Clicks vs. leads vs. sales are labeled distinctly.** A form submission is a lead, not a sale.
  The dashboard will not imply revenue it cannot observe.

No real client analytics property is connected until that client is explicitly migrated.

---

## 11. Payments

Admin can set a monthly price · record cash/Venmo/Stripe/other payments · define the covered
period · mark paid/due/overdue · issue **audited corrections instead of deletions** · view MRR,
month-to-date and year-to-date collections, and overdue totals.

`provider`, `provider_reference`, and a unique `idempotency_key` are in the schema from day one
so Stripe can be added later without reshaping the ledger. Stripe is **not** a dependency now.

Money is stored in **integer cents** with an explicit currency. No floats anywhere.

---

## 12. Change requests, attachments, and the automation pipeline

### 12.1 Requests

Clients submit title, description, category, priority, timing, and images. State machine per
§4.5. The client sees a clean timeline; internal agent logs stay internal.

### 12.2 Attachment security (R2)

10 MB cap enforced **server-side** (client-side check is UX only) · random opaque object keys
(no user-controlled filenames in the key) · **magic-byte signature check, not just the declared
MIME type** · allowlist of image types · image dimension and pixel-count limits (decompression
bomb defense) · `Content-Disposition: attachment` and a restrictive `Content-Type` on download ·
short-lived signed URLs (≤15 min), never public buckets · SHA-256 checksum recorded ·
`scan_status` column reserved as the malware-scan hook.

### 12.3 GitHub + Claude pipeline

```
request approved
  → portal opens marked issue in the correct client repo (GitHub App)
      body: acceptance criteria + expiring attachment links + agent-job:<public_id>
  → claude-code-action@v1 runs in automation mode
      ⚠ workflow MUST list our App in `allowed_bots` (§1.3 Gotcha A)
  → Claude opens a PR
  → signed webhooks → correlate repo/issue/PR/workflow/request → agent_jobs
  → timeout watchdog marks stalled jobs
  → PR presented to you in the portal
  → merge ONLY after your authorization AND all checks pass
  → wait for deployment, verify live
  → record completion or rollback
```

**Webhook receiver requirements:** read the **raw body before any parsing** · verify
`X-Hub-Signature-256` HMAC-SHA256 · **constant-time comparison** · idempotency via the unique
index on `X-GitHub-Delivery` · verify `repository.node_id` against the allowlist · event/action
allowlist (everything else → 202 and ignore) · handle duplicate and out-of-order deliveries ·
logs that never contain payload secrets or tokens.

**Merge guards — refuse if any of these hold:** PR is a draft · repository is not allowlisted ·
base branch is not the expected default · any required check is not `success` · `head_sha`
changed since your approval · PR author is not our app or Claude · changed files fall outside
the allowed paths for the request.

**Daily dispatch cap: default 10**, configurable globally and per repository.

The Claude credential lives only in GitHub Actions secrets — **never in the portal database or
application**.

---

## 13. Security, caching, and SEO strategy

### 13.1 SSRF defense for the prospect crawler

The crawler takes a URL from the operator and fetches it — the classic SSRF shape. Controls:
`https` scheme only · reject credentials in the URL · resolve DNS and **block private, loopback,
link-local, and cloud-metadata ranges** (`127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`,
`::1`, `fc00::/7`) · **re-check after every redirect** (a public host can redirect to
`169.254.169.254`) · cap redirects · response size and time limits · no cookie or auth header
forwarding · respect `robots.txt` · rate limited and page-capped.

### 13.2 Untrusted content handling

Crawled page content, webhook payloads, uploaded filenames, and issue bodies are **data**. They
are stored as attributed facts and are never concatenated into an agent instruction. Any text
that appears to instruct ("ignore previous instructions", "you are now…") is stored and shown to
you, never acted upon.

### 13.3 Headers and general hardening

CSP with nonces (no `unsafe-inline`) · `Strict-Transport-Security` · `X-Content-Type-Options:
nosniff` · `Referrer-Policy: strict-origin-when-cross-origin` · restrictive `Permissions-Policy` ·
`frame-ancestors 'none'` on the portal · secrets only in Worker secrets and GitHub Actions
secrets, never in the database, never in `NEXT_PUBLIC_*`.

### 13.4 PWA and caching safety

**Never cached:** passwords, auth responses, any mutation, signed URLs, cross-client data, admin
data. Dashboard data is **network-first** with a visible last-updated/offline indicator. All
caches are cleared on logout, account switch, and impersonation start/end. The service worker
and cache names are versioned, and upgrades from an old build are explicitly tested.

**If tenant-safe offline caching proves at all uncertain, we ship an offline shell only.** A
stale cross-tenant page in a service worker cache is a data breach; a blank offline page is an
inconvenience.

**For all sites and previews:** content-hashed JS/CSS · atomic deploys · correct cache headers
(immutable for hashed assets, `no-store` for HTML on the portal) · previous-version assets
retained so an open tab does not 404 · detection of missing chunks, hydration failures, and CSS
load failures, with a prompt to reload · **an explicit test that a tab opened on the previous
deployment still works after a new deployment.** We never rely on "clear your browser cache".

### 13.5 SEO-safe migration (only after explicit authorization)

Back up repository and site · inventory URLs, titles, descriptions, headings, canonicals,
structured data, redirects, forms, images/PDFs, status codes · record analytics and Search
Console baselines where authorized · **preserve domain and URLs wherever practical** · one-to-one
redirect map for changed URLs · **never redirect unrelated pages to the home page** · preserve
content and search intent · keep staging non-indexed · preserve Google Business Profile identity
and reviews · test Search Console verification, analytics, forms, HTTPS, sitemap, robots,
canonicals, redirects · require launch approval · monitor indexing, errors, rankings, traffic,
conversions afterward.

**No promise is made that rankings will not fluctuate.** Any migration report states this plainly.

---

## 14. Preview and localhost strategy

Every generated concept and site supports: local install/build/test commands · a localhost URL
reported to you · a hosted Cloudflare preview for remote review · HTTPS · **non-indexed prospect
previews, verified after deploy** · preview-only/safe form handling (never a real inbox) ·
preview expiration and archive · responsive screenshots.

**Localhost is not shareable by default.** A Cloudflare Quick Tunnel is offered only when you
explicitly ask for one during a live session, and is never started automatically.

---

## 15. Implementation stages

| Stage | Content | Gate |
| --- | --- | --- |
| **0** | This plan | **← you are here; awaiting approval** |
| 1 | GitHub org + approved platform repos, settings, rulesets | Approval before any creation |
| 2 | App foundation, Neon, Drizzle migrations, seed, Auth.js, roles, tenant tests | Cross-tenant tests must pass |
| 3 | Current + Potential Clients UI, demo data only, migration gate screen | Demo data only |
| 4 | Theme library: themes, schemas, versioning, compatibility, screenshots, tests | Generic data only |
| 5 | Analytics (mock → Umami), R2, payments, requests, notifications, PWA | — |
| 6 | Prospect generation: audit, approval, repo, scaffold, preview, screenshots | Plan approval gate |
| 7 | GitHub App, issues, signed webhooks, job tracking, PR review/merge, verification | Merge guards tested |
| 8 | Hardening: security, quotas, caching, recovery, a11y, full tests, docs | — |
| 9 | Migration readiness UI + checklist — **then stop** | **No repository read without your written authorization** |

Each stage ends with a report and stops for approval. Stage 9 ends the build; migration is a
separate authorized activity.

---

## 16. Exact resources and files to create in Stage 1

### 16.1 External resources (only after approval)

| Resource | Detail |
| --- | --- |
| GitHub organization | `<agency-organization>` — **requires your browser step** (terms + plan selection) |
| GitHub repos | `agency-platform`, `agency-portfolio`, `agency-theme-library` (+ `agency-documentation` if D7 = yes) |
| Org teams | `owners`, `platform-admins` |
| Org settings | Per §3.2 |
| Rulesets | Per §3.3 on each repo's `main` |

Neon, Cloudflare, R2, Umami, Resend, and the GitHub App are **Stage 2+**, not Stage 1.

### 16.2 Local workspace layout

```
WebsiteBusiness/                      ← this folder; a workspace root, NOT a git repo
├── docs/
│   └── stage-0-infrastructure-plan.md   ← this document
├── agency-platform/                  ← Stage 1, own git repo
├── agency-portfolio/                 ← Stage 1, own git repo
└── agency-theme-library/             ← Stage 1, own git repo
```

### 16.3 Initial contents of each repo

```
<repo>/
├── .gitignore              node, next, wrangler, .env*, .DS_Store, .open-next
├── .env.example            NAMES AND COMMENTS ONLY — never values
├── README.md               what it is, how to run, how to deploy
├── SECURITY.md             reporting, secret handling, rotation policy
├── CONTRIBUTING.md         branch/PR/commit conventions, required checks
├── LICENSE                 UNLICENSED / proprietary
└── docs/architecture.md    diagram, boundaries, data flow, decisions
```

`agency-platform` additionally scaffolds (Stage 2):

```
src/app/(public)/            marketing-adjacent public routes
src/app/(admin)/             overview · current-clients · potential-clients · requests
                             themes · payments · analytics · settings   [admin role gate]
src/app/(client)/            client dashboard only                      [client role gate]
src/app/api/webhooks/github/ raw-body signature verification
src/db/schema/               Drizzle tables, one file per domain
src/db/repositories/         TENANT-SCOPED access layer (§5.2)
src/lib/auth/                Auth.js config, PBKDF2 hashing, rate limit
src/lib/github/              App auth, issues, PR guards
src/lib/analytics/           server-side Umami proxy
src/lib/storage/             R2 signed URLs, validation
drizzle/                     versioned migrations
tests/                       unit · integration · cross-tenant · webhook · upload
wrangler.jsonc               nodejs_compat, compat date ≥ 2024-09-23
open-next.config.ts
```

### 16.4 Where each secret will live — **never paste any of these into chat**

| Secret | Home | Set via |
| --- | --- | --- |
| `DATABASE_URL` (Neon) | Cloudflare Worker secret | `wrangler secret put` / dashboard |
| `AUTH_SECRET` | Cloudflare Worker secret | `wrangler secret put` |
| R2 credentials | Worker binding (no key needed in code) | `wrangler.jsonc` binding |
| `UMAMI_API_KEY` | Cloudflare Worker secret | `wrangler secret put` |
| `RESEND_API_KEY` | Cloudflare Worker secret | `wrangler secret put` |
| GitHub App private key + webhook secret | Cloudflare Worker secret | `wrangler secret put` |
| `ANTHROPIC_API_KEY` *or* OIDC federation | **GitHub org Actions secret** | GitHub org settings UI |
| `CLOUDFLARE_API_TOKEN` (deploys) | GitHub org Actions secret | GitHub org settings UI |
| Local development values | `.env.local`, git-ignored | Your editor, on your machine |

I will never ask you to paste a password, token, private key, database URL, or OAuth secret into
this chat. Everything above is configured by you in the relevant dashboard or CLI.

---

## 17. Accounts and permissions required

| Account | Needed by | Your action | Cost |
| --- | --- | --- | --- |
| GitHub — org owner | Stage 1 | Create org in browser (terms + plan) | Free |
| Cloudflare | Stage 2 | Account + **Workers Paid** (see D2) | **$5/mo** |
| Neon | Stage 2 | Account + 2 projects (portal, umami) | Free |
| Umami host | Stage 5 | Pick a host (D5) | Free–$7/mo |
| Resend | Stage 5 | Account + verify 1 domain | Free |
| Anthropic Console | Stage 7 | API key or OIDC federation rule (D3) | Usage-based |
| Domain registrar | Stage 2 | Own/point the agency domain | ~$12/yr |

Total expected recurring: **$5/month** (Workers Paid), plus domain and Claude API usage.

---

## 18. Risks, honestly stated

| # | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| R1 | Workers Free 10 ms CPU cannot run this platform | **Blocking** | Workers Paid $5/mo — decision D2 |
| R2 | claude-code-action rejects bot actors → every portal-triggered run fails | **Blocking** | `allowed_bots` in the client workflow template from day one |
| R3 | OAuth token ties commercial client work to your personal subscription | High | Console API key or OIDC federation — decision D3 |
| R4 | Umami cannot run on Workers; needs a separate host | Medium | Separate host + separate Neon project — decision D5 |
| R5 | Neon 0.5 GB/project — Umami events will eventually exceed it | Medium | Isolated Neon project; retention policy; monitor |
| R6 | Private-repo Actions minutes consumed by Claude runs | Medium | Dispatch cap of 10/day; `--max-turns`; concurrency limits |
| R7 | Cross-tenant data leak | **Critical** | Structural repository split + mandatory 404-not-403 tests |
| R8 | Service worker caching a cross-tenant page | **Critical** | Offline shell only if there is any doubt |
| R9 | Concept site publishes an unverified claim (licence, price, guarantee) | High | Build fails if an `unverified` or `sensitive` fact would render |
| R10 | SSRF via the prospect crawler | High | Full IP-range blocking with post-redirect re-checks |
| R11 | `@opennextjs/cloudflare` is pre-1.0 and moving | Medium | Pin exact versions; verify at each upgrade |
| R12 | Accidental live-site change during migration | **Critical** | Scope enforced in code; no write path exists at `read_only_audit` |

---

## 19. Decisions I need from you

| # | Decision | Status |
| --- | --- | --- |
| **D1** | Agency name, GitHub org name, confirmed GitHub owner account | **Settled — "Mortensen Web Co."** GitHub org `mortensenweb`. Owner: GitHub account `cjackmort`. See §19a-3. |
| **D2** | Cloudflare Workers Paid at $5/mo | **Settled — deferred.** Not needed until first portal deploy (Stage 5–7). All of Stages 1–4 are local and cost $0. See §1.2a. |
| **D3** | Claude Actions credential | **Settled — personal OAuth token** (`CLAUDE_CODE_OAUTH_TOKEN`). Acceptable for a single-operator agency; migration to a Console API key is a one-line workflow change. See §1.3a. |
| **D4** | Agency domain + portal subdomain | **Settled — `mortensenweb.com`**, portal at `portal.mortensenweb.com`. Verified unregistered 2026-08-14; not required until Stage 5. |
| **D5** | Umami host | **Settled — Umami Cloud Hobby (free) to start**, self-host on a VPS later. See §10. |
| **D6** | Theme distribution: vendor at scaffold vs. private npm | **Open** — recommend vendor |
| **D7** | Create `agency-documentation` now? | **Open** — recommend no |
| **D8** | Repo names — accept the defaults? | **Open** — recommend yes |
| **D9** | Business timezone | **Settled — `America/Denver`** (Utah; MST/MDT with DST) |
| **D10** | Admin email for the seeded admin account | **Settled — `cjackmort@gmail.com`** |
| **D11** | Resend sending domain | **Settled — `notifications.mortensenweb.com`** |

### §19a-3 — FINAL name selection: "Mortensen Web Co." (checked 2026-08-14)

Operator requested a namesake name. All eight GitHub org handles checked were available; three of
four `.com` candidates were unregistered.

| Candidate | GitHub org | `.com` | Verdict |
| --- | --- | --- | --- |
| **Mortensen Web** | **`mortensenweb` available** | **unregistered** | ✅ **Selected** |
| Mortensen Works | available | unregistered | Runner-up |
| Mortensen Digital | available | unregistered | Available, not chosen |
| Mortensen Studio | available | Registered 2024, GoDaddy, all four locks | ✗ |

Positive control: `mortensenstudio.com` returned a full record from the same Verisign endpoint, so
the three 404s are reliable negatives.

**Rationale.** A surname firm signals a real, accountable person — which is what a contractor
weighs when choosing who to trust with their business, and it is the same convention used by law,
accounting, and architecture practices. "Web" is chosen over "Works" or "Digital" for **referral
clarity**: word of mouth is the likely primary channel, and "call Mortensen Web, they did my site"
carries its own explanation, where "Mortensen Works" would need the referrer to add what the
business does. "Digital" was rejected as vague to trades clients.

The trading name carries "Co." — **Mortensen Web Co.** — which reads as a firm rather than a
freelancer, while the domain stays short and easy to say over the phone.

**Superseded candidates:** "StudioSite" (exact `.com` held since 1996, org taken; also
descriptive and weak as a mark) and "Plumbline Web" (clean, but superseded by the namesake
request). Full evidence retained in §19a and §19a-2 history.

### §19a-2 — Superseded candidate: "Plumbline Web" (checked 2026-08-14)

"StudioSite" was withdrawn after both the exact-match `.com` (held since 1996) and the GitHub org
proved unavailable; the operator delegated the naming decision. A second and third round of
single-name lookups produced:

| Candidate | GitHub org | `.com` | Verdict |
| --- | --- | --- | --- |
| Bright Anvil | `brightanvil` taken | Registered 2020, Porkbun | ✗ |
| Switchback Studio | taken | Registered 2024, **Afternic nameservers — parked for resale** | ✗ |
| Northbound Studio | taken | Registered 2020, GoDaddy, all four locks | ✗ |
| Cairnworks | taken | not reached | ✗ |
| Craftline | taken | Registered 2000, **Sedo Parking** | ✗ |
| Anvil & Ash | available | Registered 2025, NameCheap | ✗ |
| **Plumbline Web** | **`plumblineweb` available** | **`plumblineweb.com` unregistered** | ✅ **Selected** |

Positive control for the RDAP negatives: the same Verisign endpoint returned full records for
`plumbline.com` and `craftline.com`, so the 404 on `plumblineweb.com` is a reliable negative.

**Rationale.** A plumb line is the tool that establishes true vertical — the word means straight,
true, correct. Every trade uses one (HVAC, construction, window cleaning), and artists use one
too, for checking verticals in drawing and composition. It therefore addresses both halves of the
client base with a single word. It is distinctive rather than descriptive, so unlike "StudioSite"
it is defensible as a mark, and it is two common words that survive being spelled over the phone.

**Known collision:** `plumbline.com` is held by an active company (Netregistry registrar, AWS
DNS), so the brand is "Plumbline Web" on the domain rather than bare "Plumbline". Different
apparent sector and country; noted for the record.

**CANONICAL IDENTIFIERS (authoritative — use these everywhere from Stage 1 onward):**

| Item | Value |
| --- | --- |
| Brand / trading name | **Mortensen Web Co.** |
| GitHub organization | `mortensenweb` |
| GitHub owner account | `cjackmort` |
| Domain | `mortensenweb.com` |
| Portal | `portal.mortensenweb.com` |
| Analytics (if self-hosted later) | `analytics.mortensenweb.com` |
| Resend sending domain | `notifications.mortensenweb.com` |
| Admin email | `cjackmort@gmail.com` |
| Timezone | `America/Denver` |
| Platform repositories | `agency-platform`, `agency-portfolio`, `agency-theme-library` |

### §19a — "StudioSite" availability findings (checked 2026-08-14)

Each name below was checked by **direct single-name lookup**. No repositories were listed and no
account was enumerated.

| Handle | Status | Evidence |
| --- | --- | --- |
| GitHub org `studiosite` | ❌ **Taken** | `GET /users/studiosite` → 200, type `Organization` |
| GitHub org `studio-site` | ❌ **Taken** | `GET /users/studio-site` → 200, type `Organization` |
| GitHub org `studiositehq` | ✅ Available | 404 |
| GitHub org `studiositeco` | ✅ Available | 404 |
| GitHub org `studiosite-agency` | ✅ Available | 404 |
| GitHub org `getstudiosite` | ✅ Available | 404 |
| `studiosite.com` | ❌ **Registered** | Verisign RDAP: created **1996-02-19**, Squarespace Domains II LLC, expires 2027-02-20, transfer + delete locks |
| `studiositehq.com` | ✅ Unregistered | Verisign RDAP 404 (same endpoint that returned data for `studiosite.com`, so this is a reliable negative) |
| `getstudiosite.com` | ✅ Unregistered | Verisign RDAP 404, same control |
| `studiosite.studio` | ⚠️ Likely available — **unverified** | Identity Digital RDAP 404, but no positive control on that endpoint; confirm at a registrar |
| `studiosite.co` | ⚠️ Not checked | RDAP endpoint unreachable (`rdap.nic.co` did not resolve) |

**Note for the record:** the exact-match `.com` has been held continuously since 1996 and the
GitHub org is taken, which indicates the term is well-trodden. "StudioSite" is also a descriptive
mark (studio + site), which is harder to protect than a distinctive one. The operator has chosen
the name with these facts available; the brand is settled and the work proceeds on it. Only the
handle needs selecting.

### §19b — GitHub token scope gap (blocks Stage 1)

`gh auth status` reports account `cjackmort` with scopes `gist`, `read:org`, `repo`. Two required
scopes are missing:

| Scope | Needed for | Have it? |
| --- | --- | --- |
| `repo` | Creating and pushing to private repositories | ✅ |
| `admin:org` | Creating teams, org settings, org-level Actions secrets | ❌ **Missing** |
| `workflow` | Pushing `.github/workflows/` files — the entire Claude automation depends on this | ❌ **Missing** |

Fix before Stage 1: `gh auth refresh -h github.com -s admin:org,workflow`

Separately: **GitHub exposes no REST endpoint for creating an organization** under a personal
account (`POST /admin/organizations` is GitHub Enterprise Server only). Organization creation is
necessarily a browser step by the operator at <https://github.com/organizations/plan>.

### D2 addendum (§1.2a) — when the $5 is actually needed

The Workers Free blocker is **CPU per invocation (10 ms)**, not monthly request volume, so it
cannot be outrun by having low traffic — it fails on the first request. However, the cost is
still genuinely deferrable, because nothing needs deploying until late:

| Stage | Runs where | Cost |
| --- | --- | --- |
| 1 — org + repos | GitHub | $0 |
| 2 — app, DB, auth | Local (`next dev`) — no CPU cap | $0 |
| 3 — client UIs | Local | $0 |
| 4 — theme library | Local | $0 |
| 5–7 — **first portal deploy** | Cloudflare Workers | **$5/mo starts here** |

`agency-portfolio` is mostly static (static asset serving is free and unlimited on Workers) and
will likely run fine on the free plan indefinitely — to be measured at deploy time, not assumed.

### D3 addendum (§1.3a) — OAuth token accepted, with the trade-off recorded

Operator has chosen `CLAUDE_CODE_OAUTH_TOKEN`. Recorded consequences:

- Runs bill against the operator's personal Claude subscription rather than API billing.
- The token is tied to the individual who generated it; it is not a shareable team credential.
- It expires after **one year** and must be rotated manually.
- Migration path if the agency grows: swap the org secret for `ANTHROPIC_API_KEY` and change one
  line per workflow (`claude_code_oauth_token:` → `anthropic_api_key:`). No architectural change.

Unchanged: the credential lives **only** in GitHub Actions secrets — never in the portal
database, application code, or any environment variable the portal reads.

Note on GitHub organization creation: it **always** requires a browser step from you (accepting
terms and choosing a plan). I will not create an organization under an ambiguous account, and I
will confirm the exact owner with you before Stage 1.

---

## 20. Seed / demo data (Stage 2)

One admin (your email, forced password change) · one demo current client
("Northwind Comfort Systems", `demo-hvac.example`) · one demo potential client
("Cascade Glass Care", `https://example.com`) · demo sites, payments, requests · mock analytics ·
generic theme examples.

Every demo record carries an `is_demo` flag and a visible **DEMO** badge in the UI.
**No real client, repository, or domain appears in seed data.** The seed script refuses to run
when `NODE_ENV=production` unless an explicit `ALLOW_PRODUCTION_SEED` flag is set, so
development credentials can never work silently in production.

---

## 21. Documentation to be written (Stage 8, drafted as we go)

Organization/account setup · repository creation · local development · Neon/migrations/seed ·
Cloudflare Workers/R2 · Umami · Resend · GitHub App + webhooks · Claude workflow credential
setup · adding a potential client · generating a concept · converting prospect to client ·
adding a brand-new current client · **authorizing one existing-client migration** ·
preview/approval/launch · SEO migration · rollback · cache incident · secret rotation ·
backup/restore · quota exhaustion · offboarding and ownership transfer.

---

## 22. Testing requirements

Formatting/lint/type checks · unit and integration tests · **auth and cross-tenant tests** ·
database constraint and migration tests · **webhook signature and idempotency tests** · upload
security tests · build tests · link/asset checks · accessibility · SEO metadata/sitemap/robots/
canonical · mobile and desktop browsers · visual screenshots · **preview noindex verification** ·
live verification · **cache upgrade / stale-tab scenario** · failure and rollback paths.

Cross-tenant, webhook signature, and preview-noindex tests are **blocking** — a failure there
stops the stage.

---

## 23. Migration gate (Stage 9 and beyond)

After infrastructure is complete, the portal shows a migration screen and **stops**.

Migration begins only when you provide authorization in this form:

> I authorize migration discovery for current client `<client name>` using repository
> `<exact owner/repo>`. Read only this repository, do not modify or deploy it, and produce the
> migration audit.

Per migration: verify exact repository identity → confirm read-only audit scope → **read no
other repository** → scan for secrets without printing values → produce audit and options →
**stop for approval** → only then make approved changes on a branch → preview and test →
**stop for launch approval**.

No bulk import. No crawling of your account. One client at a time.
