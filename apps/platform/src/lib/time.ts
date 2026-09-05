/**
 * Dates and times, in the business's own timezone.
 *
 * Every date the portal shows a client is "when did this happen" from the
 * point of view of a business in one place. The server that renders the page
 * runs in UTC, so a bare `toLocaleDateString` would print the UTC day —
 * which after 5pm in Denver is tomorrow. The timezone therefore always comes
 * from `BUSINESS_TIMEZONE`, the same setting the scheduler and the dispatch
 * quota use to decide what "today" means, so the two can never disagree.
 */

export function businessTimeZone(): string {
  return process.env.BUSINESS_TIMEZONE ?? "America/Denver";
}

/** `Sep 4` */
export function formatDate(value: Date | string): string {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: businessTimeZone(),
  });
}

/** `Sep 4, 2026` */
export function formatDateWithYear(value: Date | string): string {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: businessTimeZone(),
  });
}

/** `7:12 PM` */
export function formatTime(value: Date | string): string {
  return new Date(value).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: businessTimeZone(),
  });
}

/** `Sep 4, 7:12 PM` */
export function formatDateTime(value: Date | string): string {
  return `${formatDate(value)}, ${formatTime(value)}`;
}
