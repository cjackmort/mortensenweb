# agent/

What the automated change pipeline is made of, in one place.

| | |
| --- | --- |
| `skills/` | Skills copied into every agent run (`.claude/skills/` in the client repository's workspace). `site-change` is the procedure for every request; the rest are read for anything beyond a copy or image edit. |
| `verify/check.mjs` | Structural checks on a built site: links and images resolve, alt text, no external images, no lorem ipsum, a title per page. Run by the deploy workflow on every pull request and by the agent before it opens one. Zero dependencies. |
| `verify/screenshot.mjs` | Phone- and desktop-width screenshots of the home page and every page the pull request changed, written into `dist/__preview/` so they deploy with the preview. The portal shows the phone shot beside the approve button. |

The workflows that use these live in `.github/workflows/client-change.yml` and `client-deploy.yml`; client repositories call them (see `templates/client-repo/.github/workflows/`). Editing anything here changes every client's next run once it is on `main`.

`skills/` is a copy of the relevant part of the `web-studio` Claude plugin. Improve them here for the agent's purposes; the plugin is the studio's own tool.
