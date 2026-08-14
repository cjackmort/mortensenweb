# Mortensen Web Co. — Agency Operating Platform

Private monorepo for the agency: a public site, a secure admin/client portal, a theme library for
building business websites quickly, a prospect concept generator, and a guarded GitHub + Claude
automation pipeline for website changes.

**Status:** Stage 1 — repository scaffolding. No application code yet.

---

## Repository layout

```
mortensenweb/
├── apps/
│   ├── platform/          Admin + client portal        (Stage 2)
│   └── portfolio/         Public agency site           (Stage 2)
├── packages/
│   └── theme-library/     Design system + themes       (Stage 4)
└── docs/                  Architecture and runbooks
```

Client and prospect websites are **not** in this repository. Each gets its own private repository
(`client-<company>-website`, `prospect-<business>-<job-id>`) so the Claude automation can operate
on one client at a time with narrowly scoped access.

## Stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Framework | Next.js App Router | |
| Hosting | Cloudflare Workers via `@opennextjs/cloudflare` | **Not** `next-on-pages`, which is superseded |
| Database | Neon Postgres + Drizzle ORM | Versioned migrations |
| Auth | Auth.js v5, credentials + JWT | PBKDF2-HMAC-SHA-256 via Web Crypto |
| Storage | Cloudflare R2 | Attachments, screenshots |
| Analytics | Umami, server-side proxy only | API key never reaches the browser |
| Email | Resend | Logs to console in development |
| Automation | GitHub App + `anthropics/claude-code-action@v1` | |

Requires **Cloudflare Workers Paid** ($5/mo) before the portal can be deployed — the free plan's
10 ms CPU per invocation cannot cover password hashing or server rendering. Local development is
unaffected and free. See `docs/stage-0-infrastructure-plan.md` §1.2.

## Getting started

Nothing to install yet. Stage 2 adds the applications, database schema, and scripts.

```bash
git clone https://github.com/cjackmort/mortensenweb.git
cd mortensenweb
cp .env.example .env.local   # then fill in locally — never commit it
```

## Non-negotiables

These are enforced in code, not by convention. Changing any of them is a deliberate decision, not
a refactor.

1. **Tenant isolation.** Every client-facing query goes through a repository layer that requires a
   session-derived `orgId`. Admin queries live in a separate module a client route cannot import.
   Cross-tenant tests assert **404, not 403** — a 403 confirms the record exists.
2. **Secrets never live in the database or application.** See `SECURITY.md`.
3. **No client repository is read without written authorization** naming that exact repository.
   See the migration gate in `docs/stage-0-infrastructure-plan.md` §23.
4. **Untrusted content is data, never instructions.** Crawled pages, webhook payloads, uploaded
   filenames, and issue bodies are stored and displayed, never executed as directions.
5. **Generated sites are pinned to a theme version.** A theme update can never silently change a
   deployed client site.
6. **Prospect previews are non-indexed**, and the noindex is verified after deploy, not assumed.

## Documentation

- [`docs/stage-0-infrastructure-plan.md`](docs/stage-0-infrastructure-plan.md) — the full
  architecture, schema, decisions, verified free-tier limits, and risk register. Start here.
- [`docs/architecture.md`](docs/architecture.md) — system diagram and trust boundaries.
- [`SECURITY.md`](SECURITY.md) — secret handling and rotation.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — branch, commit, and review conventions.

## Licence

Proprietary. All rights reserved. See [`LICENSE`](LICENSE).
