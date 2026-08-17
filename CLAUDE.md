# Mortensen Web Co.

A website agency run by one person, with the repetitive parts automated. The
portal takes a change request from a client, an agent implements it in that
client's own repository, the client approves a preview, and it goes live.

`docs/architecture.md` is the reference. `docs/stage-0-infrastructure-plan.md`
and `docs/stage-3-automation-plan.md` carry the reasoning behind decisions that
look arbitrary otherwise.

## Getting set up on a new machine

```bash
git clone https://github.com/cjackmort/mortensenweb.git
cd mortensenweb
npm install
```

**Do not put the working copy inside OneDrive.** File locking and sync produce
failures that read like corruption, and a stale mirror there has already caused
one session to edit files nobody was running. `C:\dev\mortensenweb` is where it
lives.

Create `apps/platform/.env.local` from `.env.example` — that file lists every
variable by name and says where each belongs. For local development you need
very little: with no `DATABASE_URL` the app runs an embedded Postgres (PGlite)
in `.pglite/`, and with no `RESEND_API_KEY` the mailer logs to the console
instead of sending.

```bash
npm run db:migrate --workspace apps/platform   # creates the local database
npm run db:seed --workspace apps/platform      # demo client and admin login
npm run dev --workspace apps/platform
```

## Commands

| | |
| --- | --- |
| `npm run dev --workspace apps/platform` | development server |
| `npm test --workspace apps/platform` | the suite (232 tests) |
| `npm run lint --workspace apps/platform` | ESLint, flat config |
| `npm run typecheck --workspace apps/platform` | `tsc --noEmit` |
| `npm run db:generate --workspace apps/platform` | migration from a schema change |
| `npm run db:migrate --workspace apps/platform` | apply to the local database |

CI runs lint, typecheck, tests and build on every pull request, and applies
migrations to Neon on merge to `main`. Nothing needs running by hand.

## What is live

| | |
| --- | --- |
| Portal | `portal.mortensenweb.com` (Netlify) |
| Database | Neon Postgres |
| GitHub App | `mortensen-web-portal`, installed on all repositories |
| Template | `cjackmort/client-site-template`, marked as a template |
| First client | Scott Mortensen Fine Arts — `cjackmort/ScottMortensenWebsite` |

Square is built and tested but has no account behind it; the driver, webhook
receiver and checkout are complete and dormant. `docs/square-setup.md` is the
setup, `docs/github-app-setup.md` the equivalent for GitHub.

## Things that cost a day to learn

Every one of these failed **silently** — no error, nothing in a log, a system
that looked healthy.

**Netlify bakes environment variables in at build time.** Adding or changing one
does nothing until the next deploy. A stale `DATABASE_URL` 500s only the pages
that query, so `/login` still returns 200 and the site looks fine. Check with
`curl -o /dev/null -w "%{http_code}" https://portal.mortensenweb.com/preview/notarealtoken`
— 404 means the database answered, 500 means it did not.

**Anything unauthenticated must be listed in `middleware.ts`.** Webhook
receivers, signed attachment links and `/api/cron` all authenticate themselves
and none can hold a session. An unlisted route is redirected to `/login` and
answered 307 — so the scheduler ran every five minutes for a day, recorded a
response, reported success, and never once reached the endpoint. Every job it
runs was silently absent.

**`secrets` is not available in a workflow `if:` condition.** It is a parse
error, not a falsy no-op: the run fails in zero seconds with no job starting,
which reads exactly like CI never triggered.

**Turbopack records environment values in its build cache**, which Netlify's
secrets scanning then finds. `SECRETS_SCAN_OMIT_PATHS` must name
`apps/platform/.netlify/.next/cache/**` — the scanner reports paths relative to
the repository root, not to `base`, so omitting `.next/cache/**` alone matches
nothing and fails identically.

**Client repositories need `id-token: write` and an explicit `--allowedTools`.**
Without the first, `claude-code-action` cannot fetch an OIDC token and every run
dies on its first step. Without the second, a run succeeds in twenty seconds
having produced nothing — it reads the issue, works out what to do, and has no
way to do it. Succeeding while doing nothing is worse than failing, because the
portal is told the job worked.

**PGlite is single-writer.** The dev server holds the lock, so a script hitting
the same database will block until it stops.

## Conventions worth keeping

Comments explain **why**, never what. If a line looks odd, the comment says what
would go wrong without it.

Guards refuse rather than permit. The merge guard, the allowlist and the
entitlement checks are all written as reasons to stop, so an unanticipated state
is a refusal instead of an accident.

Money is never implied. A client saying they paid, a payment link being opened
and a card being authorised are three different facts, each recorded separately,
and none of them is `paid`.

Nothing is invented on a client's behalf. An unconfirmed detail stays an obvious
placeholder — a wrong phone number on a real business's website is worse than a
visible gap.

## Known gaps

- Square is unexercised; no account, no webhook subscription
- Plan override and billing render inside the per-site loop, though both are
  client-level
- No health endpoint; production health is inferred from status codes
- Prospect site crawling does not exist, so briefs are typed by hand
- The theme library is a stub — Stage 4, and the largest remaining piece
- Two deploy models: scaffolded repositories publish themselves by CLI, while a
  repository connected in place uses Netlify's Git integration. Now that a
  Netlify `installation_id` is known to be readable and reusable, these could
  collapse into one.
