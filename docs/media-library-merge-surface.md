# Merging `feat/media-library` alongside other work

Written because a concurrent analytics branch was expected and could not be
found: no open pull request, no unmerged remote branch that adds a migration,
and both `feat/click-analytics` and `feat/billing-auth-and-analytics` already in
`main`. Rather than guess at its contents, this records exactly what the media
library claims, so whoever starts that work can see a collision before hitting
it rather than during a merge.

## The one that bites silently

**Migration `0019_media_library.sql`, journal index 19.**

If another branch also creates a `0019_*`, the merge conflict in
`drizzle/meta/_journal.json` is obvious and easy. The dangerous case is the
quieter one: two entries both claiming `idx: 19`, resolved by keeping both, at
which point the ordering between them is whatever the JSON merge happened to
produce.

Worse, and learned the hard way in this branch: **drizzle records applied
migrations by hash, so editing a migration that has already run is silently
ignored.** A column added to an existing file will simply never appear, and the
first sign is a `column … does not exist` error at runtime. If either branch's
migration has been applied anywhere — including a developer's local PGlite — the
fix is a *new* migration, never an edit.

Whichever branch merges second should renumber to `0020` and take the next free
journal index. Nothing else in this branch depends on the number.

## Schema changes to existing tables

Three, all additive, none of which rewrite or drop anything:

| Table | Column | Why it exists |
| --- | --- | --- |
| `clients` | `media_quota_bytes` | Per-client storage allowance. Null means the platform default. |
| `clients` | `media_reserved_bytes` | Atomic quota counter. See `db/repositories/client/media-quota.ts`. |
| `change_requests` | `idempotency_key` | Makes submitting a request idempotent, with a partial unique index on `(organization_id, idempotency_key)`. |

A branch that also adds columns to `clients` or `change_requests` conflicts only
in the schema file, not in behaviour.

## Shared files, and what changed in each

New files under `src/app/dashboard/media/`, `src/app/api/media/`,
`src/lib/media/`, `src/db/schema/media.ts` and the `media-*` repositories are
this branch's own and cannot conflict.

These are the ones that already existed:

| File | Change | Conflict risk |
| --- | --- | --- |
| `src/db/client.ts` | `getDb()` caches on `globalThis` rather than a module variable | **High if touched.** Not cosmetic — see below. |
| `src/app/api/cron/route.ts` | Three jobs appended to the `jobs` array | High. Any branch adding a scheduled job edits the same list. |
| `src/components/app-shell.tsx` | One nav item added to `CLIENT_NAV` | High. Any branch adding a tab edits the same array. |
| `src/app/globals.css` | ~480 lines appended, all `.media-*` | Low. Appended at the end, no existing rule changed. |
| `src/db/schema/enums.ts` | Three enums appended | Low. Appended. |
| `src/db/schema/index.ts` | One export appended | Low. |
| `src/proxy.ts` | `/api/media/agent` added to `PUBLIC_PATHS` | Medium. |
| `src/app/dashboard/requests/*` | Photo field replaced by a library picker; idempotency key; draft persistence | **High.** Substantially rewritten. |
| `src/db/repositories/admin/agent-jobs.ts` | Media assets added to dispatch, with snapshotting | Medium. |
| `src/db/repositories/admin/{cancel,shipped}.ts` | One call each, to release or publish media usage | Low. |
| `src/db/repositories/client/change-requests.ts` | Idempotency on `createChangeRequest` | Medium. |
| `src/lib/github/issue.ts` | Attachment section gains dimensions, folder and Range guidance | Low. |
| `src/lib/storage/driver.ts` | Deploy-scoped stores outside production; media driver and key helpers | Medium. |
| `src/lib/storage/signed-links.ts` | Media token functions appended | Low. |
| `.github/workflows/ci.yml` | `migrate-preview` job added | Medium. |

### The `db/client.ts` change is load-bearing

It looks like a refactor and is not. In development the bundler gives server
components and route handlers separate instances of that module, so a
module-scoped cache produces two database handles in one process. With Neon that
is merely wasteful. With PGlite each handle opens its own embedded Postgres over
`./.pglite`, and a row written through a route handler is invisible to a page
rendering in the other instance — an uploaded image returned 200, served
correctly from its own endpoint, and did not appear in the library at all.

If a merge reverts this, that class of bug comes back and looks like data loss.

## Environment and configuration

- No new **production** environment variable. Netlify Blobs is provisioned
  automatically.
- `MEDIA_DIR` is local development only, and production must leave it unset —
  the driver refuses to fall back to disk there.
- `PREVIEW_DATABASE_URL` is a new secret on a new `preview` GitHub environment,
  used only by the pull-request migration job.
- `.gitignore` gains `.media/`.
