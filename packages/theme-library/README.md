# packages/theme-library

Design system and industry themes. **Not yet implemented — arrives in Stage 4.**

Generic, original components and safe placeholder assets only. No real client content, imagery, or
business data enters this package at any point.

## Planned structure

```
tokens/       colour, type, space, radius, shadow, motion
primitives/   Button, Card, Section, Container, Field, Icon — accessibility complete
blocks/       Nav · Hero · Services · Reviews · Gallery · CTA · Footer, several variants each
schema/       Zod content schemas; required vs optional fields per theme
generator/    Scaffolder: theme + content → site repository
themes/
  hvac/            traditional-trust · modern-comfort · emergency-response
                   premium-residential · commercial-mechanical
  artists/         minimal-gallery · luxury-editorial · western-bronze
                   contemporary-studio
  window-cleaning/ bright-and-clean · residential-friendly · commercial-glass
  car-detailing/   dark-luxury · performance · clean-premium
```

Extension paths prepared for plumbing, roofing, landscaping, carpet cleaning, construction,
professional services, restaurants, local retail, nonprofits, and engineering/technology.

## Versioning

Every generated site is pinned at scaffold time:

```json
{
  "theme": "hvac/modern-comfort",
  "version": "1.4.2",
  "sourceCommit": "a1b2c3d",
  "generatedAt": "2026-08-14T00:00:00Z"
}
```

**A theme update must never silently change a deployed client site.** Upgrading a site is an
explicit, reviewed, per-site pull request.

## Avoiding clones

Variation is structural, not cosmetic: navigation layout, hero composition, section order, service
card shape, review presentation, type pairing, palette role assignment, and image treatment vary
independently. A compatibility matrix, tested in CI, records which blocks may combine, so the
generator varies freely inside proven combinations and never emits a broken pairing.
