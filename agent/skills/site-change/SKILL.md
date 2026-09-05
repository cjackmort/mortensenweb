---
name: site-change
description: >
  This skill should be used for every change to a client's website made from a
  portal request — a copy edit, a new photo, a price, a seasonal banner, a new
  section. It is the procedure: find the exact place, make the smallest diff,
  build, run the checker, and describe the change for the owner. Read it before
  editing anything in a client repository.
metadata:
  version: "0.1.0"
---

# Making a change to a client's site

A real business's website, edited unattended, approved by its owner on a phone. The standard is not "it works" but "the owner can see exactly what changed, nothing else moved, and nothing is broken". Work in this order.

## 1. Understand the request before touching a file

Read the issue's quoted block as a description of an outcome, not a set of steps. Restate it to yourself in one sentence: "Replace the photo in the services section with the one named *new*, and put the price $120 under it." If the request is ambiguous in a way that matters — two places it could mean, a photo that could be either of two — pick the reading that changes least and say in the pull request which you chose and why. If it is ambiguous in a way that could put wrong information on the site (a price, a phone number, a date), escalate instead of guessing.

Read `CLAUDE.md` for where things live and the "Facts about this site" section. Sites that predate the template differ a lot.

## 2. Find the exact place

`grep -rn` for the current text, the current image filename, or a nearby heading. Confirm there is one occurrence — or, if there are several (a phone number in the header and the footer), that the request means all of them. Look at the surrounding markup so the edit keeps the same element, the same classes, and the same indentation.

## 3. Make the smallest diff that fulfils the request

- Copy: edit the text in place. Keep the surrounding tone, capitalisation and punctuation style. Do not reflow or reformat the block.
- Image swap: reference the new file; keep the `<img>` element, its classes, `width`/`height` if present, and update `alt` to describe the new picture. Update every reference, including any `<link rel="preload">`.
- New image: only one the client attached (download and commit it) or one already in the repository. Never an external URL. Never a substitute.
- Price, hours, date, phone: change only the value. Check the same value is not repeated elsewhere on the site (footer, contact page, schema JSON-LD in `<head>`).
- New section or new page: read the `layout-and-buttons`, `hero-sections`, `web-copy` and `seo` skills first. Reuse the site's existing classes and tokens; do not introduce a second visual language. A new page needs a `<title>`, a description, one `<h1>`, a link from the navigation, and an entry in `sitemap.xml` if one exists.
- Animation or motion: read the `animation` skill. Respect `prefers-reduced-motion`. One effect, not five.
- Anything touching `.github/`, `.claude/`, `package.json`, deploy config, credentials: do not. Escalate.

Do not fix unrelated things you notice. Mention them in the pull request instead — the owner is approving *this* change.

## 4. Tag what should be measured

If the change adds a phone link, email link, form submit, or a photo the owner might care about, add `data-umami-event` as `CLAUDE.md` describes (`photo: <name>`, `called`, `emailed`, `enquiry sent`). If you replace a tagged element, keep the tag.

## 5. Build and check — before the pull request, not after

```bash
npm run build
node .claude/skills/site-change/scripts/check.mjs dist
```

The checker fails on: a link or image that does not resolve to a file, an image with no `alt`, an image loaded from another site, lorem ipsum, a page with no `<title>`. Fix every error. Read the warnings: a placeholder you did not introduce is fine to leave; one you introduced is not.

If the site has no `npm run build`, or the build fails for a reason unrelated to your change, escalate with the build output in the reason.

## 6. Commit, push, open the pull request

Branch from the default branch: `portal/<issue-number>-<short-slug>`. One commit is fine. Commit any downloaded photos.

The pull request description:

1. First line: the `<!-- agent-job:... -->` marker, copied verbatim from the issue.
2. If escalating: the `<!-- agent-escalation: reason -->` line, then what you would need.
3. Then, **for the owner** — two to five short sentences. What is different now and where on the site ("The services section now shows the new photo, with $120 under it"). Anything you deliberately did not do and why ("I left the header phone number alone because the request only mentioned the footer"). No file names, no HTML, no jargon. This text appears in their portal beside the approve button.

## 7. Record what you learned

If you had to work something out — a page generated from a data file, a class that controls the hero, an image directory that is not `src/images/` — add one line under "Facts about this site" in `CLAUDE.md` in the same pull request. Facts, not a log.

## Escalation is a correct outcome

Escalate when the change needs a decision only the owner can make, an asset that does not exist, a new page or structural rewrite on a site whose structure you cannot reproduce safely, or when you have tried and are not confident. A specific reason — "needs the new price for the second service too" — lets a person finish it in minutes.
