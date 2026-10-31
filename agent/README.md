# agent/

What the automated change pipeline is made of, in one place.

| | |
| --- | --- |
| `skills/` | Skills copied into every agent run (`.claude/skills/` in the client repository's workspace). `site-change` is the procedure for every request; the rest are read for anything beyond a copy or image edit. |
| `verify/check.mjs` | Structural checks on a built site: links and images resolve, alt text, no external images, no lorem ipsum, a title per page. Run by the deploy workflow on every pull request and by the agent before it opens one. Zero dependencies. |
| `verify/screenshot.mjs` | Phone- and desktop-width screenshots of the home page and every page the pull request changed, written into `dist/__preview/` so they deploy with the preview. The portal shows the phone shot beside the approve button. |

**This folder is no longer the live copy.** The workflows (`client-change.yml`, `client-deploy.yml`) and the skills and checks they run now live in the public repository `cjackmort/mortensenweb-agent`, which every client repository calls (the callers are in `templates/client-repo/.github/workflows/`). Editing anything here changes nothing for a client, and this copy has already fallen behind: `verify/check.mjs` lacks the framing checks, and `skills/site-change/SKILL.md` lacks the client-summary markers and second-attempt guidance.

It is kept for one reason: `.github/workflows/ci.yml` runs `verify/check.mjs` against the public site's build (`apps/portfolio/dist`). The newer checker would flag that site's deliberate `X-Frame-Options: DENY`, so CI was left on this copy. Nothing else in the portal reads `skills/` or `verify/screenshot.mjs`; make changes to those in `cjackmort/mortensenweb-agent`.

`skills/` is a copy of the relevant part of the `web-studio` Claude plugin.
