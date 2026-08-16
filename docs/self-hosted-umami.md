# Self-hosted Umami

Analytics runs on its own small VPS. This is the arrangement §10 of the
infrastructure plan settled on, reached earlier than planned because Umami
Cloud's free tier is limited and its paid tier costs more than a box that can
serve every client at once.

**Cost:** roughly $5/month, flat, regardless of how many clients you have.
Umami itself is MIT-licensed with no site or event limits.

## Why not Neon for this database

Recorded here because it is counter-intuitive and the plan already litigated it.
A self-hosted Umami holds a persistent connection pool, which prevents Neon's
scale-to-zero. At Neon's 0.25 CU floor that is `0.25 × 730 h ≈ 182 CU-hours` per
month against a **100 CU-hour** free allowance — gone in about two and a half
weeks. Postgres therefore runs in a container next to Umami on the same VPS.
Portal data stays on Neon, where scale-to-zero works normally.

## Before you start

You need a VPS and a hostname. Neither can be provisioned from this repository.

**VPS** — anything with 2 GB RAM is comfortable; 1 GB works. Hetzner CX22
(~€4/mo) or DigitalOcean's $6 droplet are both fine. Choose Ubuntu 24.04 LTS.

**Hostname** — Umami must be reachable over HTTPS with a valid certificate,
because browsers refuse to load a tracking script from an untrusted origin and
you would collect nothing while everything *looked* fine.

Two ways to get one:

- **You own a domain.** Point an `A` record for `analytics.yourdomain.com` at
  the VPS IP. Best option; do this once `mortensenweb.com` is registered.
- **You don't yet.** Use `sslip.io`, which resolves any IP-shaped hostname to
  that IP. A VPS at `203.0.113.45` is reachable at
  `analytics.203-0-113-45.sslip.io`, and Let's Encrypt will issue a real
  certificate for it. Perfectly valid to start with; moving to a proper domain
  later is a hostname change plus re-pointing each site's tracking snippet.

## Setup

Copy `infra/umami/` to the VPS, then:

```bash
# 1. Docker
curl -fsSL https://get.docker.com | sh

# 2. Secrets — generate, never invent
cd umami
cp .env.example .env
echo "POSTGRES_PASSWORD=$(openssl rand -base64 32)" >> .env
echo "APP_SECRET=$(openssl rand -base64 32)" >> .env
# then edit .env to set ANALYTICS_HOSTNAME and ACME_EMAIL

# 3. Start
docker compose up -d

# 4. Watch the certificate get issued
docker compose logs -f caddy
```

Open `https://<your-hostname>` and sign in with Umami's default credentials —
**`admin` / `umami`** — then change the password immediately. That default is
public knowledge and the instance is on the open internet from the moment Caddy
gets its certificate.

## Connecting it to the portal

1. In Umami: **Websites → Add website**. Name it, set the domain to the client's
   real domain, and copy the **website ID**.
2. In the portal: **Clients → the client → Sites & analytics**, paste the
   website ID.
3. In Umami: **profile → Settings → API keys → Create key**.
4. In the portal's environment:

   ```
   UMAMI_API_BASE_URL=https://<your-hostname>/api
   UMAMI_API_KEY=<the key>
   ```

   Note the `/api` suffix — self-hosted and Cloud differ, and the portal
   deliberately does not guess. Cloud would be `https://api.umami.is/v1`.

5. Restart the portal. Environment variables are read once at startup.

### If your Umami version has no "API keys" screen

Older self-hosted builds authenticate with a bearer token from
`POST /api/auth/login` instead of a long-lived API key. The portal's client
sends both `Authorization: Bearer` and `x-umami-api-key`, so a token works —
but tokens expire, so this needs a refresh step in
`src/lib/analytics/umami.ts` rather than a static env var. Upgrading Umami is
the easier fix.

## The tracking snippet

Add to every page of the client site, immediately before `</head>`:

```html
<script defer src="https://<your-hostname>/script.js"
        data-website-id="<website-id>"></script>
```

## Operating it

- **Back up the database.** Everything lives in the `umami-db` volume.
  `docker compose exec db pg_dump -U umami umami | gzip > umami-$(date +%F).sql.gz`,
  on a cron, copied off the box. A VPS you have not backed up is a VPS whose
  disk failure loses every client's history.
- **Update:** `docker compose pull && docker compose up -d`.
- **This box is now a dependency of every client's analytics.** If it is down,
  events are lost for that period — they are not queued and replayed. That is
  the real cost of self-hosting versus paying someone else to hold it up.
