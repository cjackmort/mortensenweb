# Architecture

Summary and system diagram. The authoritative design document, including the full database
schema, verified free-tier limits, decision log, and risk register, is
[`stage-0-infrastructure-plan.md`](stage-0-infrastructure-plan.md).

## System

```
                          ┌──────────────────────────────┐
   Public visitors  ─────▶│  apps/portfolio              │  mortensenweb.com
                          │  Next.js / OpenNext / Workers│  mostly static
                          └──────────────┬───────────────┘
                                         │ contact form
                                         ▼
                          ┌──────────────────────────────┐
   Admin + clients  ─────▶│  apps/platform               │  portal.mortensenweb.com
                          │  Next.js App Router          │
                          │  OpenNext → Cloudflare Worker│
                          └───┬────┬────┬────┬────┬──────┘
                              │    │    │    │    │
        ┌─────────────────────┘    │    │    │    └──────────────────┐
        ▼                          ▼    │    ▼                       ▼
  ┌───────────┐         ┌──────────────┐│ ┌──────────┐      ┌────────────────┐
  │ Neon      │         │ Cloudflare R2││ │ Resend   │      │ GitHub App     │
  │ Postgres  │         │ attachments  ││ │ email    │      └───┬────────┬───┘
  │ (Drizzle) │         │ screenshots  ││ └──────────┘          │        │
  └───────────┘         └──────────────┘│                 issues│        │webhooks
                                        ▼                       ▼        │(signed)
                              ┌──────────────────┐      ┌────────────────┴──────┐
                              │ Umami analytics  │      │ client-* / prospect-* │
                              │ SERVER-SIDE PROXY│      │ repos + Claude Action │
                              │ ONLY — key never │      │ → PR → checks → merge │
                              │ reaches browser  │      └───────────┬───────────┘
                              └──────────────────┘                  │
                                                                    ▼
                                                        ┌───────────────────────┐
                                                        │ Cloudflare Workers    │
                                                        │ preview + production  │
                                                        └───────────────────────┘

  packages/theme-library ── consumed at scaffold time, version-pinned, never deployed
```

## Trust boundaries

Three, and they are the security backbone.

**1. Client ↔ client.** Enforced server-side on every query and mutation. Client-facing
repositories require a `TenantContext` that can only be constructed from a verified session; admin
repositories are a separate module that a client route cannot import. This is structural, not a
code-review convention. Public IDs are 128-bit random *and* every lookup is additionally scoped by
`org_id`, so guessing is the second barrier, not the only one.

**2. Client ↔ admin.** Role gate plus separate route groups. Client users never reach Potential
Clients, Payments administration, or Settings/Integrations.

**3. Platform ↔ untrusted external content.** Crawled prospect pages, webhook payloads, uploaded
files, and issue bodies are **data, never instructions**. Crawled content is stored as
source-attributed facts with a verification status, and only user-verified or user-supplied facts
may render into a generated site. Text that appears to instruct an agent is stored and surfaced to
the operator, never acted upon.

## Why Workers and not Pages

`@cloudflare/next-on-pages` is superseded. `@opennextjs/cloudflare` targets Workers, runs on the
Node.js runtime rather than edge-only, and supports current Next.js versions. It requires the
`nodejs_compat` flag and a compatibility date of `2024-09-23` or later, and does not support
`export const runtime = "edge"` anywhere in the app.

## Why the portal needs Workers Paid

The free plan allows **10 ms of CPU per invocation**. That is per request, not per month, so low
traffic does not avoid it. PBKDF2 at 600,000 iterations costs hundreds of milliseconds, and server
rendering a dashboard exceeds 10 ms on its own. Splitting hashing into a service-bound Worker does
not help — the limit applies per invocation there too. Local development is unaffected.

## Repository strategy

This monorepo holds the platform, the public site, and the theme library. Client and prospect
websites live in their own private repositories, created on demand, because the Claude automation
operates per repository with narrowly scoped access and a per-repository allowlist.

Generated sites **vendor** their theme at scaffold time and record the exact version in
`theme.lock.json`. This keeps each client site self-contained, lets the automation edit real
component source rather than an opaque dependency, and guarantees that updating a theme never
silently changes a deployed client site.
