# apps/portfolio

Public agency website. **Not yet implemented — arrives in Stage 2.**

Next.js deployed to Cloudflare Workers, at `mortensenweb.com`. Mostly static, so it will likely
run within the Workers free plan indefinitely — to be measured at deploy time, not assumed.

## Content at launch

Value proposition · services · website creation process · rapid update and analytics services ·
theme previews using **generic demo businesses** · contact and qualification form · portfolio in
an empty or explicitly labelled demo state.

## Portfolio rule

The public portfolio query hard-filters `publicDisplayApproved = true` in the repository method
itself. No real client appears here until that client is explicitly migrated **and** separately
approved for public display. Approval is a stored decision, not a config toggle.
