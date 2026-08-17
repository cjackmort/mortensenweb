# Running a migration against production

Migrations do **not** run on deploy. `netlify.toml`'s build command is
`next build`, and nothing invokes `db:migrate` — so a schema change needs
someone to run it deliberately, against Neon, before the code that depends on it
goes live.

Deploying first is the failure mode worth naming: the new code lands in front of
a database without the new tables, and every query touching them fails at
runtime. Additive migrations like 0004 are safe to run *early* — nothing
currently deployed reads the new columns — so "migrate, then merge" is always
the right order.

## The connection string is a credential

It contains the `neondb_owner` password, and Neon endpoints are reachable from
the internet. Anyone holding it can read every client record, payment, and
password hash in the system.

So it goes in a file, not on a command line. A command line ends up in shell
history and is visible to any other process on the machine through `ps`.

`.env.migrate` is deliberately **not** `.env.local`. `next dev` loads
`.env.local`, so a production connection string in that file would silently
point local development at the live database — a far worse outcome than the
inconvenience of a second file.

## Steps

1. Create `apps/platform/.env.migrate` containing one line:

   ```
   DATABASE_URL=postgresql://…
   ```

   It matches `.env.*` in `.gitignore`, so it cannot be committed. Verify with
   `git check-ignore -v apps/platform/.env.migrate` if you want to be sure.

2. Run the remote variant, which reads that file:

   ```
   npm run db:migrate:remote --workspace apps/platform
   ```

   Plain `db:migrate` is the local one — it reads `DATABASE_URL` from the
   environment and, finding none, migrates the embedded PGlite database instead.

3. Success is one line: `Migrations applied to Neon.`

4. Delete `apps/platform/.env.migrate` when finished. It is ignored by Git, but
   a production credential sitting on disk has no reason to outlive the task.

## If it fails

**`fetch failed` / connection error.** Usually Neon's compute has scaled to zero
after five minutes idle. Run it again; the first attempt wakes it.

**`password authentication failed`.** The string is stale — most likely the role
password was rotated and Netlify's `DATABASE_URL` was updated but this file was
not.

**It reports PGlite instead of Neon.** `DATABASE_URL` was not read. The driver is
chosen by whether the value starts with `postgres://` or `postgresql://`, so a
quoted, truncated, or missing value silently falls back to the local embedded
database — which is why the success line naming Neon matters.

## Rotating the password

Neon Console → project → **Roles** → `neondb_owner` → **Reset password**. Then
update `DATABASE_URL` in Netlify (Site configuration → Environment variables,
production context) and redeploy, or the live portal will be holding a dead
credential.

Rotate whenever the string has been somewhere it should not be: a chat window, a
screenshot, a pasted terminal log, a support ticket.

## Making this unnecessary

The durable fix is a GitHub Actions workflow that runs the migration on merge to
`main`, with `DATABASE_URL` as a repository secret. The string gets pasted once,
into GitHub's encrypted secret field, and never appears in a terminal or a file
again. Not built yet.
