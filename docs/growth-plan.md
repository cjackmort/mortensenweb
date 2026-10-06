# Growth — bringing clients more customers

A new client tab, **Growth**, for the work that happens *after* a site is live:
catching the enquiries it produces, turning finished jobs into reviews and
content, and showing the client, every month, what all of it is worth.

Text messaging is out of scope. It needs carrier registration (A2P 10DLC) per
sending number and a second provider, and email covers every feature below.

## Packaging

| | Who gets it |
| --- | --- |
| Leads inbox | Every client |
| Monthly report | Every client |
| Review requests, job showcase, print kit, win-back emails | **Growth add-on** |

The free half is the half that proves value. A client who sees every enquiry in
one place, and gets a report each month saying how many there were, has a
reason to keep paying for the site — and a reason to want the add-on.

The add-on is an entitlement like `analyticsUnlockedAt`: a timestamp on the
client, granted by an operator in v1. Selling it through Stripe/Square is a
billing change and waits until the add-on exists to sell. A locked feature is
shown on the Growth tab with one line on what it does and a "Ask about Growth"
button, never as a dead link.

## The order, and why

1. **Leads inbox** — the client asked for it, and every later feature reports
   into it (a review request is sent to a lead; a print campaign is credited
   with leads).
2. **Monthly report** — free, mostly assembles data that already exists.
3. **Add-on entitlement + review requests** — the highest-value paid feature,
   and it needs no AI.
4. **Print kit** — tracked links and QR codes, then printable designs.
5. **Job showcase** — the first feature that dispatches to the agent for
   marketing work rather than a site change.
6. **Win-back emails** — reuses the showcase's agent path and the review
   engine's sending, unsubscribe and suppression machinery.

---

## 1. Leads inbox — built

**Turning it on in production:**

1. Set `NETLIFY_FORMS_WEBHOOK_SECRET` on the portal's Netlify site (any long
   random string) and redeploy — Netlify bakes env vars in at build time.
2. Apply migration `0024_leads` (CI does it on merge). It must reach
   production before `0024_promos`; see the note at the top of the migration.
3. For each client: admin → client → Website → **Leads inbox → Connect**.
4. In Netlify, turn off any email notification on that site's form, or the
   client gets two emails per enquiry.
5. The site's form must be a Netlify form (`data-netlify="true"`) with form
   detection enabled on the site.


Every contact-form submission from a client's site, in the portal, with its
contents, so the client stops checking their email and Netlify separately.

**Capture stays on Netlify Forms.** Client sites already submit there (the
template's `data-netlify` form), Netlify filters spam, and a submission is
accepted even while the portal is down. Moving capture to a portal endpoint
would make every client's contact form depend on the portal being up.

**Delivery is Netlify's outgoing webhook**, `submission_created`, signed with a
per-portal secret (`NETLIFY_FORMS_WEBHOOK_SECRET`) as a JWS in
`X-Webhook-Signature`: an HS256 JWT with `iss: "netlify"` and `sha256` of the
raw body. The receiver verifies both the JWT and the body hash, maps the
payload's `site_id` to `sites.netlify_site_id`, and upserts by Netlify's
submission id, so redelivery is a no-op.

Webhook rather than polling because of `CLAUDE.md`'s Neon lesson: anything on
a five-minute timer keeps the database awake all month. A webhook touches the
database only when a customer actually writes in.

**Backfill and repair** use the existing submissions API
(`/sites/:id/submissions`). The operator connects a site from its admin page,
which registers the hook and imports what Netlify already holds. A delivery
missed while the portal was down is caught by the same import, run from the
six-hourly sweep.

**What the client sees:** `/dashboard/growth/leads` — newest first, unread in
bold, a count on the Growth tab. Each lead shows name, email, phone and message
(pulled from the submitted fields by common names, with every field shown below
as submitted), the page it came from, and a status the client sets: **New →
Contacted → Won / Lost**, or **Archived**. Email and phone are links.

**Notification:** one email to the client per new lead, linking to it. Netlify's
own email notification for the site should be switched off once the hook is
connected, or the client gets two.

**What it does not do:** decide whether a lead is real. `inquiries.ts` already
separates accepted, spam and qualified, and *qualified* is only ever set by a
person. "Won" is the client's word, never inferred.

**Privacy:** lead contents are the client's customer data, stored in their
tenant like everything else, never read by the analytics path (which stays on
`fetchNetlifyInquiries`' id/time/referrer selection). A client can delete a
lead outright.

## 2. Monthly report

On the first of each month, an email and a page at `/dashboard/growth/report`
covering the previous month against the one before: visitors, calls and emails
clicked (Umami events the template already tags), leads received and their
outcomes, and — once those features exist — review requests sent, showcase
posts published, and print-campaign scans.

Runs inside the existing six-hourly sweep with a "sent for this month" marker,
so it adds no timer of its own. Every figure carries the same honesty rules as
the dashboard: a click is labelled a click, a lead is labelled a lead, nothing
is called a sale.

## 3. Review requests (add-on)

The client picks a won lead, or types a customer's name and email, and the
portal emails them a short request with a direct link to the business's Google
review form (`https://search.google.com/local/writereview?placeid=…`), with
one follow-up after five days if the link was not clicked.

- **Everyone is asked.** No "were you happy?" gate that routes unhappy
  customers away from Google — that breaks Google's policy and the FTC's 2024
  rule on consumer reviews.
- The review link is a new business-profile field the operator fills once.
- Sent from the portal's domain *as* the business ("Smith Plumbing via
  Mortensen Web"), with the client's email as reply-to.
- Every email carries an unsubscribe link; an unsubscribed address is
  suppressed for that client permanently, and the suppression list is shared
  with win-back emails.
- Shows: sent, opened link, follow-up sent. Whether a review was actually left
  cannot be known without the Google Business Profile API, and is not claimed.

## 4. Print kit (add-on)

**Tracked campaigns first.** The client names a campaign ("Oak St door
hangers") and the portal generates a link to their site with UTM parameters and
a QR code for it. Umami already records UTM sources, so scans appear in the
report with no new tracking. The client template captures first-touch UTM into
a hidden form field, so a lead from that campaign is credited to it.

**Then designs.** Door hanger, flyer, yard sign and business-card layouts,
rendered to print-ready PDF with the QR code, the business's details from its
profile and a photo from its media library. Rendering runs in the agent's
Actions runner (Playwright is already there for screenshots), dispatched
through the same path as the showcase.

## 5. Job showcase (add-on)

The client uploads three or four photos of a finished job with a sentence about
it. One agent run produces:

- a **project page** on their site, delivered as an ordinary pull request
  through preview → Apply, not counted against the monthly change allowance;
- a **Google Business Profile post** (text + chosen photo) to copy across;
- **Instagram/Facebook graphics** at 1080×1920 and 1080×1350, with captions.

The site page travels the existing pipeline. The marketing outputs come back
through a **signed, single-job callback** (`/api/growth/agent/[token]`), shaped
exactly like `/api/media/agent`: minted at dispatch, names one job, expires. It
keeps marketing copy and graphics out of the client's website repository, where
they would be one wrong path away from being deployed.

Posting to Google and Instagram is the client's step in v1 — copy, download,
post. Posting for them needs Google Business Profile API approval and a Meta
app review, both worth pursuing once clients are using this.

## 6. Win-back emails (add-on)

The client uploads past customers (CSV: name, email, last service, date) and
picks a campaign type — seasonal reminder, "it's been a year", offer. The agent
drafts the email from the business profile; the client edits and approves; the
portal sends it in batches with an unsubscribe link and the business's postal
address (CAN-SPAM requires both on commercial email).

- Uploading requires the client to confirm these are their own past customers.
- The suppression list from review requests applies.
- **Resend's free tier is 100 emails a day.** A real campaign needs the paid
  plan before this ships.

---

## Out of scope for now

- **Text messaging** — decided against.
- **Auto-reply to a lead** — useful, but sends mail to an address a stranger
  typed into a form; it needs per-site rate limits and the suppression list
  first, so it follows review requests.
- **Showing reviews on the site** — needs the Places API (billed) or the Google
  Business Profile API (approval).
- **Running Google Ads** — a service, not a portal feature, until there is a
  client to learn on.
