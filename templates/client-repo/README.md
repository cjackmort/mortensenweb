# Client site template

Everything in this directory is copied into a new repository when the portal
scaffolds a site. GitHub's template-repository feature does the copying
(`POST /repos/{owner}/{repo}/generate`), so this must exist as a real repository
marked **Template** in its settings — not just as files here.

## What has to be true before scaffolding works

### 1. This is a real template repository

Push these files to a repository under the agency account and tick
**Settings → Template repository**. Then set, in the portal's environment:

```
GITHUB_TEMPLATE_OWNER=<account>      # defaults to GITHUB_REPO_OWNER
GITHUB_TEMPLATE_REPO=<repo name>
GITHUB_REPO_OWNER=<account>          # where new client repos are created
GITHUB_INSTALLATION_ID=<id>          # the App's installation on that account
```

### 2. `APP_ACTOR_LOGIN` is replaced in `claude.yml`

`anthropics/claude-code-action` refuses to run for a bot actor unless that bot
is named in `allowed_bots`. The portal opens issues as the GitHub App, which
*is* a bot actor, so without this every run fails immediately.

The value is the App's actor login — usually `<app-slug>[bot]`. Find it by
opening any issue the portal created and reading the author name, or:

```bash
gh api /repos/OWNER/REPO/issues/1 --jq .user.login
```

This applies to `workflow_dispatch` too, so it cannot be sidestepped by
changing the trigger.

### 3. Account-level secrets exist

Set once, on the account, and inherited by every scaffolded repository:

| Secret | Used by | Notes |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude.yml` | Billed against the operator's Claude subscription. The portal never reads it and has no code path that could. |
| `NETLIFY_AUTH_TOKEN` | `deploy.yml` | Personal access token from Netlify. |

`NETLIFY_SITE_ID` is **not** in this table. It is a per-repository Actions
*variable*, written by the portal at scaffold time. A site id is not
confidential — it appears in deploy URLs and build logs — and keeping it out of
the secrets API is what lets the portal provision repositories without carrying
libsodium to seal secret values.

## The two workflows

| File | Trigger | What it does |
| --- | --- | --- |
| `claude.yml` | issue labelled `claude` | Reads the issue, implements the change, opens a pull request |
| `deploy.yml` | pull request / push to `main` | Deploys a preview alias / production |

They are separate on purpose. `claude.yml` writes code; `deploy.yml` publishes
it. Merging them would mean the credential that can edit the repository and the
credential that can publish to the live site are held by the same run.

## The build contract

`deploy.yml` runs `npm ci`, then `npm run build`, then publishes `dist`. A
scaffolded site therefore needs:

- a `package.json` with a `build` script
- a lockfile committed (`npm ci` fails without one)
- output written to `dist`

Any static generator satisfying that works. Change `--dir=dist` in `deploy.yml`
if a generator insists on another directory, and change it in the template
rather than per repository, or the two will drift.

## What the agent must never touch

Stated in `claude.yml`'s prompt, and independently enforced by the portal's
merge guard, which refuses to merge a pull request touching any of:

```
.github/   netlify.toml   package.json   package-lock.json   Dockerfile
```

The duplication is deliberate. The prompt is an instruction and instructions can
be argued with; the merge guard is a refusal and cannot.
