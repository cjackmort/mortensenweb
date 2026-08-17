# Creating the GitHub App

The portal acts as a GitHub App rather than as you with a personal token. That
choice is what makes per-client isolation real: an installation token is scoped
to one installation and expires in an hour, so a leaked one cannot reach every
client repository and cannot be used indefinitely.

Roughly ten minutes. Three settings in here are easy to get wrong and each
fails in a way that does not explain itself, so they are called out.

## 1. Create it

**github.com → your avatar → Settings → Developer settings → GitHub Apps →
New GitHub App.**

| Field | Value |
| --- | --- |
| GitHub App name | Anything unique, e.g. `Mortensen Web Portal` |
| Homepage URL | `https://portal.mortensenweb.com` |
| Webhook → Active | **ticked** |
| Webhook URL | `https://portal.mortensenweb.com/api/webhooks/github` |
| Webhook secret | Generate one and keep it — this becomes `GITHUB_WEBHOOK_SECRET` |

Generate the webhook secret with something unguessable:

```bash
openssl rand -base64 32
```

Under **Where can this GitHub App be installed?** choose **Only on this
account**.

## 2. Repository permissions

Each of these is used by a specific call the portal makes. Granting less means
a 403 at the moment that call runs, which is usually well after setup and looks
like an unrelated bug.

| Permission | Level | Why |
| --- | --- | --- |
| **Administration** | Read & write | Creating a repository from the template |
| **Contents** | Read & write | Template generation, and the agent's commits |
| **Issues** | Read & write | The portal opens the issue the agent works from |
| **Pull requests** | Read & write | Reading the PR, its files, and merging it |
| **Checks** | Read | Merge guard: has CI passed? |
| **Commit statuses** | Read | Merge guard again — a separate system from checks, and reading only one is how a red build gets merged |
| **Workflows** | Read & write | The template contains `.github/workflows`; copying those files needs it |
| **Secrets** | Read & write | Sealing `CLAUDE_CODE_OAUTH_TOKEN` and `NETLIFY_AUTH_TOKEN` into each new repo |
| **Variables** | Read & write | Writing `NETLIFY_SITE_ID` |
| **Metadata** | Read | Mandatory; GitHub selects it for you |

Nothing else. In particular the App needs no account permissions and no access
to email or profile data.

## 3. Subscribe to events

Under **Subscribe to events**, tick exactly these three:

- **Pull request**
- **Check suite**
- **Workflow run**

They match what the receiver handles. Anything else is acknowledged and
dropped, so subscribing more widely only adds noise to the delivery log.

## 4. Create, then collect three values

Press **Create GitHub App**. On the page that follows:

- **App ID** is near the top → `GITHUB_APP_ID`
- **Generate a private key** downloads a `.pem` → `GITHUB_APP_PRIVATE_KEY`

Paste the private key **whole**, including the `-----BEGIN-----` and
`-----END-----` lines and its newlines. The portal accepts both the PKCS#1
format GitHub hands you and PKCS#8, and unescapes `\n` if the value arrives
escaped — so pasting it straight from the file is correct.

## 5. Install it — on **All repositories**

**Install App** in the left sidebar → your account → and this is the setting
that matters:

> **Choose "All repositories", not "Only select repositories".**

A repository created from a template is **not** automatically added to the
App's installation. With "Only select repositories", the portal would create a
client repo successfully and then be unable to touch it — no secrets, no
issues, no merges. The failure appears one step after the thing that caused it,
which makes it genuinely hard to diagnose.

"All repositories" means every new repo is covered as it appears. The App is
installed only on your own account and holds only the permissions above.

After installing, read the installation id off the URL:

```
https://github.com/settings/installations/12345678
                                          ^^^^^^^^  GITHUB_INSTALLATION_ID
```

## 6. Find the App's actor login

The workflow in every client repository must name the App in `allowed_bots`,
or `claude-code-action` refuses to run for it — every run fails immediately.

The login is normally the App's slug with `[bot]` appended: an app named
`Mortensen Web Portal` gives `mortensen-web-portal[bot]`. Confirm it by looking
at who authored the first issue the portal opens:

```bash
gh api repos/OWNER/REPO/issues/1 --jq .user.login
```

Replace `APP_ACTOR_LOGIN` in the template's `claude.yml` with that value.

## 7. Put the values in

Netlify → Site configuration → Environment variables. Tick **Contains secret
values** for the first two only.

| Variable | Secret? |
| --- | --- |
| `GITHUB_APP_ID` | no |
| `GITHUB_APP_PRIVATE_KEY` | **yes** |
| `GITHUB_WEBHOOK_SECRET` | **yes** |
| `GITHUB_INSTALLATION_ID` | no |
| `GITHUB_REPO_OWNER` | no — your account name |
| `GITHUB_TEMPLATE_OWNER` | no — same, unless the template lives elsewhere |
| `GITHUB_TEMPLATE_REPO` | no — the template repository's name |

## Checking it worked

The webhook is the easiest end to test, because GitHub sends a `ping` the
moment the App is created.

**App settings → Advanced → Recent Deliveries.** A green tick means the portal
received and verified it. A red one tells you which half is wrong:

| Response | Meaning |
| --- | --- |
| `202` | Working — signature verified, event acknowledged |
| `401` | `GITHUB_WEBHOOK_SECRET` does not match what the App holds |
| `503` | The portal has no webhook secret set at all |
| timeout | The URL is wrong, or that deploy is not live |

Then scaffold a throwaway prospect and watch a repository appear. If creation
succeeds but sealing secrets fails, the cause is almost always step 5 —
"Only select repositories".
