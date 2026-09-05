# JSON-LD Schema Templates

Place in `<head>` as `<script type="application/ld+json">`. Combine multiple entities with `@graph`. All URLs absolute. Only mark up what is visible on the page.

## Site-wide (layout)

```json
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "LocalBusiness",
      "@id": "https://example.com/#business",
      "name": "Northside Plumbing",
      "url": "https://example.com",
      "logo": "https://example.com/logo.png",
      "image": "https://example.com/og/home.png",
      "telephone": "+1-208-555-0142",
      "email": "hello@example.com",
      "priceRange": "$$",
      "address": { "@type": "PostalAddress", "streetAddress": "412 N 8th St", "addressLocality": "Boise", "addressRegion": "ID", "postalCode": "83702", "addressCountry": "US" },
      "geo": { "@type": "GeoCoordinates", "latitude": 43.6187, "longitude": -116.2043 },
      "areaServed": [{ "@type": "City", "name": "Boise" }, { "@type": "City", "name": "Meridian" }],
      "openingHoursSpecification": [
        { "@type": "OpeningHoursSpecification", "dayOfWeek": ["Monday","Tuesday","Wednesday","Thursday","Friday"], "opens": "07:00", "closes": "18:00" }
      ],
      "sameAs": ["https://www.facebook.com/…", "https://www.instagram.com/…"]
    },
    {
      "@type": "WebSite",
      "@id": "https://example.com/#website",
      "url": "https://example.com",
      "name": "Northside Plumbing",
      "publisher": { "@id": "https://example.com/#business" }
    }
  ]
}
```
Swap `LocalBusiness` for a subtype (`Plumber`, `Restaurant`, `Dentist`, `LegalService`, `HomeAndConstructionBusiness`, `MedicalClinic`, `Store`) or for `Organization` when there is no physical location. For a personal brand use `Person` with `jobTitle`, `knowsAbout`, `sameAs`.

## Service page

```json
{ "@context": "https://schema.org", "@type": "Service", "name": "Water Heater Installation", "serviceType": "Water heater installation", "provider": { "@id": "https://example.com/#business" }, "areaServed": { "@type": "City", "name": "Boise" }, "description": "…", "url": "https://example.com/water-heater-installation", "offers": { "@type": "Offer", "priceCurrency": "USD", "price": "1200", "priceSpecification": { "@type": "PriceSpecification", "minPrice": 900, "maxPrice": 2400, "priceCurrency": "USD" } } }
```

## Product

```json
{ "@context": "https://schema.org", "@type": "Product", "name": "…", "image": ["…"], "description": "…", "sku": "…", "brand": { "@type": "Brand", "name": "…" }, "offers": { "@type": "Offer", "url": "…", "priceCurrency": "USD", "price": "49.00", "availability": "https://schema.org/InStock", "itemCondition": "https://schema.org/NewCondition" } }
```
Add `aggregateRating` / `review` only with real, on-page reviews.

## Article / BlogPosting

```json
{ "@context": "https://schema.org", "@type": "BlogPosting", "headline": "…", "description": "…", "image": "…", "datePublished": "2026-09-05", "dateModified": "2026-09-05", "author": { "@type": "Person", "name": "…", "url": "…" }, "publisher": { "@id": "https://example.com/#business" }, "mainEntityOfPage": "https://example.com/blog/slug" }
```

## FAQPage (visible FAQs only)

```json
{ "@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [ { "@type": "Question", "name": "How long does installation take?", "acceptedAnswer": { "@type": "Answer", "text": "Most installations take 2–4 hours…" } } ] }
```

## BreadcrumbList

```json
{ "@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [ { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://example.com" }, { "@type": "ListItem", "position": 2, "name": "Services", "item": "https://example.com/services" }, { "@type": "ListItem", "position": 3, "name": "Water Heaters" } ] }
```

## Event

```json
{ "@context": "https://schema.org", "@type": "Event", "name": "…", "startDate": "2026-10-12T19:00-06:00", "endDate": "2026-10-12T22:00-06:00", "eventStatus": "https://schema.org/EventScheduled", "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode", "location": { "@type": "Place", "name": "…", "address": { "@type": "PostalAddress", "streetAddress": "…", "addressLocality": "…", "addressRegion": "…", "postalCode": "…", "addressCountry": "US" } }, "image": "…", "description": "…", "offers": { "@type": "Offer", "url": "…", "price": "25", "priceCurrency": "USD", "availability": "https://schema.org/InStock" }, "organizer": { "@id": "https://example.com/#business" } }
```

## Astro helper

```astro
---
const { schema } = Astro.props;
---
<script type="application/ld+json" set:html={JSON.stringify(schema)} />
```

## Next.js helper

```tsx
export function JsonLd({ data }: { data: object }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />;
}
```
