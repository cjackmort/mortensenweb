# Security

This platform holds client business data, site credentials, and repository access. The controls
below are requirements, not suggestions.

## Reporting

Security issues go to `cjackmort@gmail.com`. Do not open a public issue, and do not include a
live credential in the report — describe the exposure and its location instead.

## Where secrets live

| Secret | Correct home | Never |
| --- | --- | --- |
| `DATABASE_URL` | Cloudflare Worker secret | Committed, in the database, in a client bundle |
| `AUTH_SECRET` | Cloudflare Worker secret | Committed |
| `UMAMI_API_KEY` | Cloudflare Worker secret | Any `NEXT_PUBLIC_` variable, any client component |
| `RESEND_API_KEY` | Cloudflare Worker secret | Committed |
| GitHub App private key / webhook secret | Cloudflare Worker secret | The database, the repo |
| `CLAUDE_CODE_OAUTH_TOKEN` | **GitHub Actions secret only** | The portal database, application code, any env var the portal reads |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions secret | Committed |
| Local development values | `.env.local`, git-ignored | Committed, shared over chat or email |

`.env.example` contains **variable names only**. A real value appearing there is an incident.

Set production secrets with `wrangler secret put <NAME>`. Set Actions secrets with
`gh secret set <NAME>`, which prompts for the value so it never enters shell history.

## Rotation

| Credential | Cadence | How |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | **Expires after 1 year** | Re-run `claude setup-token`, update the Actions secret |
| `AUTH_SECRET` | On suspicion of exposure | Rotate, then increment every user's `session_epoch` to invalidate outstanding sessions |
| GitHub App private key | Annually, or on exposure | Generate a new key in app settings, update the Worker secret, then delete the old key |
| GitHub webhook secret | Annually, or on exposure | Update in app settings and the Worker secret together — deliveries fail in between |
| Database credentials | On exposure | Rotate in Neon, update the Worker secret |
| Resend / Umami API keys | On exposure | Rotate at the provider, update the Worker secret |

After any rotation, verify: the portal still authenticates, a webhook delivery still validates,
and no build is pinned to the old value.

## Application security requirements

- **Password storage:** PBKDF2-HMAC-SHA-256, 600,000 iterations, 16-byte random salt, stored
  PHC-style with the algorithm recorded so it can be migrated. Constant-time verification.
  Transparent rehash on login when parameters change. Never invent a scheme; never lower the
  iteration count to fit a platform limit.
- **Tenant isolation:** enforced at the repository layer, which requires a session-derived
  `orgId`. Cross-tenant tests assert **404, not 403**.
- **Session revocation:** `session_epoch` in the JWT, compared against the database each request.
  Disabling an account, changing a password, or ending impersonation invalidates every token.
- **Webhooks:** read the raw body before parsing, verify `X-Hub-Signature-256` with HMAC-SHA256,
  compare in constant time, enforce delivery idempotency, and check `repository.node_id` against
  an allowlist. Reject everything else.
- **Merge guards:** never merge a draft, an unexpected repository or base branch, failing checks,
  or a pull request whose head SHA changed after approval.
- **Uploads:** server-side size cap, magic-byte signature check (not just declared MIME type),
  random object keys, short-lived signed URLs, and restrictive content disposition.
- **SSRF:** the prospect crawler blocks private, loopback, link-local, and cloud-metadata IP
  ranges, and re-checks after every redirect.
- **Caching:** never cache authentication responses, mutations, signed URLs, or any cross-tenant
  data in a service worker. If tenant-safe offline caching is uncertain, ship an offline shell.

## Repository access

- Two-factor authentication required on the GitHub account.
- Client and prospect repositories are private and created on demand.
- The GitHub App is installed on selected repositories only, never "all repositories".
- No client repository is read without written authorization naming that exact repository.

## If a secret is exposed

1. Rotate it immediately — before investigating how it leaked.
2. If it reached a commit, rotation is mandatory. Rewriting history does **not** undo exposure;
   assume the value is compromised the moment it is pushed.
3. Check provider access logs for use you did not initiate.
4. Record what was exposed, when, and what was rotated.
