# This website

Instructions for the agent that makes changes to this site. The portal opens an
issue, a run implements it, and the client approves a preview before anything
goes live.

**This file is authoritative about where things are.** Read it before assuming
a path — sites differ, and the ones that predate our template differ a lot.

## Layout

| | |
| --- | --- |
| Pages | `src/*.html` |
| Styles | `src/styles.css` |
| Images | `src/images/` |
| Build | `build.mjs` → `dist/` |

A site connected from an existing repository may not look like this at all. If
what you find disagrees with the table above, **the repository is right and this
file is stale** — fix the table in the same pull request as your change.

## How to make the usual changes

**Changing text.** Find the copy in the page's HTML and edit it in place. Do not
restructure the markup around it — a copy change that reflows a section makes
the diff impossible for a non-technical person to check, and the client is the
one approving it.

**Swapping an image.** Use an image already committed to this repository. Update
every reference to the old file, including any `<link rel="preload">` in the
`<head>` — a preload left pointing at the previous image silently downloads a
file the page no longer shows. Keep the `alt` accurate to the new picture.

**Adding an image.** Only if the file is already in the repository. If the
request asks for a photo that is not here, say so in the pull request rather
than substituting something. Never link to an external URL — not the client's
old site, not a stock library. Those break, and may not be licensed.

**Removing an image.** Remove the markup, the `alt`, and any preload. Leave the
file itself in the repository unless the request says to delete it.

## What never to touch

- `.github/` — workflows, including the one running you
- `netlify.toml`, `package.json`, `package-lock.json`, any deploy config
- Anything under an environment file
- Dependencies: do not add, remove, or upgrade

These are held for a human every time, by a guard in the portal. A change that
touches them cannot merge automatically, so putting one in a content pull
request only means the content waits too.

## Facts about this site

Anything you had to work out — an unusual path, a class name that matters, a
page that is generated rather than written — **write it down here, in the same
pull request as the change that taught you.** The next run starts with no memory
of this one, and rediscovering the same thing is how a five-minute change
becomes a thirty-minute one.

Keep it to facts about the site. Not a log of what you did — the git history is
that already.
