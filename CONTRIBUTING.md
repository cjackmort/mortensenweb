# Contributing

Conventions for this repository, including work done by the Claude automation.

## Branches

`main` is always deployable. Work happens on branches:

| Prefix | For |
| --- | --- |
| `feat/` | New capability |
| `fix/` | Bug fix |
| `chore/` | Tooling, dependencies, config |
| `docs/` | Documentation only |
| `agent/` | Opened by the Claude automation from a client change request |

Example: `feat/tenant-scoped-repositories`, `agent/req-7fk2m9-hero-copy`.

## Commits

Present tense, imperative, explaining *why* where it is not obvious:

```
Add session_epoch check to auth middleware

Disabling an account previously left outstanding JWTs valid until expiry.
Comparing the token's epoch against the user row revokes them immediately.
```

Never commit a real credential. If one is committed, rotate it — rewriting history does not undo
exposure. See `SECURITY.md`.

## Pull requests

Every change reaches `main` through a pull request, including automated ones.

Before requesting review:

- [ ] Lint, type check, and tests pass
- [ ] New client-facing queries are tenant-scoped, with a cross-tenant test
- [ ] No secret added to code, `.env.example`, or the database
- [ ] Migrations are reversible, or the irreversibility is called out
- [ ] User-facing changes noted in the description

A pull request description should say what changed, why, and how it was verified.

## Automated pull requests

Pull requests from the Claude automation follow the same rules and get the same review. They are
merged by the portal only after explicit authorization **and** passing checks. The portal refuses
to merge when the pull request is a draft, targets an unexpected base, comes from an unallowlisted
repository, has failing checks, or has a head SHA that changed after approval.

Never bypass those guards manually to "unblock" a merge. If a guard fires, the guard is right
until proven otherwise.

## Migrations

Schema changes ship as versioned Drizzle migrations. Never edit an applied migration — add a new
one. Test both the upgrade and the rollback path before merging.

## Tests that block a merge

These are not optional:

- Cross-tenant isolation (404, not 403)
- Webhook signature verification and delivery idempotency
- Upload validation
- Preview `noindex` verification

## Code style

Match the surrounding code. Prefer clarity over cleverness — this platform will be maintained by
one person and an agent, and both benefit from obvious code.
