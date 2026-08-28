# apps/portfolio

The public agency site — **mortensenweb.com**. Next.js App Router, exported to
static HTML, deployed to Netlify as the `mortensenweb-site` project.

Not to be confused with `apps/platform`, which is the client portal at
`portal.mortensenweb.com` and is a different Netlify site fed by the same
repository.

## Running it

```bash
npm run dev --workspace @mortensenweb/portfolio
```

```bash
npm run build --workspace @mortensenweb/portfolio
```

The build writes static files to `out/`. There is no server: `output: "export"`
in `next.config.ts` means no route handlers, no middleware, and no
request-time rendering. That is a deliberate constraint, not an oversight — see
the comment in that file before working around it.

## Adding a site to the portfolio

One entry in [`src/data/work.ts`](src/data/work.ts), one image in
`public/work/`. No component changes.

The image should be **1120×700** (16:10) and already web-sized — the export has
no image optimiser, so whatever is committed is what visitors download. To
produce one from a source photograph:

```powershell
powershell -File tools/crop-card-image.ps1 -Source path\to\photo.jpg -Slug my-client
```

Two rules govern what may be added, and both are written out in the file's
header comment:

1. **Live client work needs the client's agreement.** The portal models this as
   a stored `publicDisplayApproved` decision; this file is the same decision
   made by hand. If you cannot point at when they agreed, it does not go here.
2. **Anything not live declares itself** through `status`. A concept or an
   unadopted redesign is worth showing — presenting one as a shipped client
   engagement is not true, and it is the kind of untruth the business in
   question notices.

## Pricing is duplicated, and that is a liability

[`src/data/plans.ts`](src/data/plans.ts) mirrors the `service_plans` rows seeded
in `apps/platform/scripts/seed.ts`. A static export cannot query the database,
so the numbers are copied — which means they can drift. **Change both in the
same commit.**

`comp-unlimited` is deliberately not listed. It is granted by an operator
rather than sold, and the seed file sorts it last precisely so it is never
pitched.

## The contact form

Netlify Forms, which works by scanning the built HTML for
`data-netlify="true"`. Three details are load-bearing and easy to lose in a
tidy-up — the hidden `form-name` input, the `action="/thanks/"` redirect, and
the off-screen honeypot. They are documented in the comment at the top of
[`src/app/contact/page.tsx`](src/app/contact/page.tsx).

Submissions land in the Netlify UI under **Forms**. Email notification is
configured there, not in this repository.
