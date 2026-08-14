# apps/platform

Admin and client portal. **Not yet implemented — arrives in Stage 2.**

Next.js App Router deployed to Cloudflare Workers via `@opennextjs/cloudflare`, at
`portal.mortensenweb.com`.

## Planned structure

```
src/app/(admin)/     Overview · Current Clients · Potential Clients · Requests
                     Themes · Payments · Analytics · Settings      [admin gate]
src/app/(client)/    Client dashboard only                         [client gate]
src/app/api/webhooks/github/    Raw-body signature verification
src/db/schema/       Drizzle tables, one file per domain
src/db/repositories/ Tenant-scoped access layer — the isolation boundary
src/lib/auth/        Auth.js config, PBKDF2 hashing, rate limiting
src/lib/github/      App auth, issue creation, PR merge guards
src/lib/analytics/   Server-side Umami proxy
src/lib/storage/     R2 signed URLs and upload validation
drizzle/             Versioned migrations
tests/               unit · integration · cross-tenant · webhook · upload
```

## Rules specific to this app

- No client-facing database access outside `src/db/repositories/`, and every function there takes
  a session-derived tenant context as its first argument.
- Admin repositories are a separate module. A client route must not be able to import one.
- Nothing in `src/lib/analytics/` may run in a client component — the Umami key is server-only.
