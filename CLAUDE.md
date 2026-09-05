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
| `npm test --workspace apps/platform` | the suite (332 tests) |
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

Square is configured in **sandbox**: token, location, webhook subscription and
signature key are set, and `/api/webhooks/square` answers 401 to an unsigned
request rather than 503. No payment has been taken end to end yet, so the
unlock path is armed but unproven. Going to production means replacing all five
values — sandbox and production share nothing. `docs/square-setup.md` is the
setup, `docs/github-app-setup.md` the equivalent for GitHub.

Prospecting has moved **out of the portal**. `/pitch` in the agency repo
researches keywords, rebuilds the site on the Astro template and previews it
locally; `/pitch-send` deploys and drafts the email. The Prospects tab is
commented out in `app-shell.tsx` — the route, crawler and tables all still
work, and one line brings it back.

## Things that cost a day to learn

Every one of these failed **silently** — no error, nothing in a log, a system
that looked healthy.

**Netlify bakes environment variables in at build time.** Adding or changing one
does nothing until the next deploy. A stale `DATABASE_URL` 500s only the pages
that query, so `/login` still returns 200 and the site looks fine. Check with
`curl -o /dev/null -w "%{http_code}" https://portal.mortensenweb.com/preview/notarealtoken`
— 404 means the database answered, 500 means it did not.

**Anything unauthenticated must be listed in `proxy.ts` (Next 16 renamed `middleware.ts`).** Webhook
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

## When you build or change a client site: the portal's tile

The admin overview draws every client as a tile, and that tile is a screenshot
of their home page taken by the deploy workflow on each push to `main`
(`agent/verify/screenshot.mjs` → `/__preview/home-tile.png`). It replaced an
iframe of the live page, which any site sending `X-Frame-Options` or a CSP
`frame-ancestors` refuses — three of the first four clients showed a blank tile
while all three sites were perfectly healthy.

Two things follow, both of which are your job when scaffolding a new site:

- **Ship `netlify.toml` from `templates/client-repo/`.** It carries
  `frame-ancestors 'self' https://portal.mortensenweb.com`, which is what makes
  a live tile possible later. Adding it up front costs nothing; retrofitting it
  means a pull request against a guarded file on someone else's repository.
- **If the home page animates above the fold, say so in the pull request and
  set the site to `live`** in the portal (client → the site → Grid thumbnail).
  A still shot is taken under `reducedMotion: 'reduce'`, so a background whose
  whole character is motion can photograph as a flat block of colour. The full
  procedure is in `agent/skills/animation/SKILL.md` — "If the home page moves,
  the portal's thumbnail has to move with it".

A static home page needs neither decision: the default is the screenshot, and
for a site that only changes when it deploys that is exactly current.

## What the client sees

The loop a client actually touches, all of it shipped and none of it yet used
by a real person:

- **Five-stage progress track** — received, making preview, needs your
  approval, published, confirmed live. `merged` sits at Published with the
  deploy running; nothing reaches "confirmed live" until the site has been
  fetched and answered.
- **Cancel**, up to the moment a change is live. Closes the pull request behind
  it and always refunds the month's change.
- **One open request per site.** The rule is sequencing, not throttling: an
  agent branch is cut from the default branch at dispatch, so a change built
  before the previous one landed can undo it on merge. The block releases at
  `merged`, the point the branch it will be cut from contains the last change.
  `blocksNewRequest` is defined as `isCancellable` and a test asserts they agree
  across every status — anything that can block a client is something they can
  clear themselves, so the rule cannot trap anyone.
- **Escalation.** The agent emits `<!-- agent-escalation: reason -->` in a pull
  request body and the request moves to `needs_operator`, surfacing in the
  admin queue with the repo, the pull request and a clone-and-run line. The
  client is told a person is handling it, never that their request was complex.

## Known gaps

- No payment has been taken through Square, in sandbox or production
- **Nothing above has been exercised through the UI by a person** — the suite
  covers the logic, but no one has clicked cancel or watched an escalation
- Client repositories scaffolded before the reusable workflows still carry a
  full copy of `claude.yml` and `deploy.yml`; each needs its two files
  replaced with the callers in `templates/client-repo/.github/workflows/`
  (one small pull request per repository) to get the shared prompt, skills,
  verification and screenshots
- The one-open-request rule is enforced in application code; a genuine
  double-submit race needs a partial unique index on `(site_id) WHERE status
  NOT IN (settled)`, not added because the migration fails if production
  already holds two open requests on one site
- Click tracking (`data-umami-event`) is read by the dashboard and the
  template tags its phone and email links; sites built before that need the
  attributes added
- Plan override and billing render inside the per-site loop, though both are
  client-level
- No health endpoint; production health is inferred from status codes
- The theme library is a stub — Stage 4, and the largest remaining piece
- Two deploy models: scaffolded repositories publish themselves by CLI, while a
  repository connected in place uses Netlify's Git integration. Now that a
  Netlify `installation_id` is known to be readable and reusable, these could
  collapse into one.
- The moderate npm advisories are all `esbuild` under `drizzle-kit`, a
  dev-only tool that never ships; clear when a fixed `drizzle-kit` lands
