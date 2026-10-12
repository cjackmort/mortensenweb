import { and, asc, eq, gte, isNull, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { eventBookings, sites } from "@/db/schema";

/**
 * Event bookings, from the system's side: what the public events feed reads.
 *
 * No context, like the forms webhook's lookups — the reader is a visitor's
 * browser on the client's website, which has no session. What scopes it is
 * the site's public id in the URL, and what makes that safe is what is
 * returned: only shows a client approved and left listed, and only the fields
 * they chose to publish. Never the performer's email, never anything from the
 * lead.
 */

export interface ListedEvent {
  publicId: string;
  actName: string;
  genre: string | null;
  eventDate: string;
  startTime: string | null;
  isTicketed: boolean;
  hasLogo: boolean;
}

const MAX_EVENTS = 100;

function listed(sitePublicId: string) {
  return and(
    eq(sites.publicId, sitePublicId),
    isNull(sites.archivedAt),
    eq(eventBookings.decision, "approved"),
    isNull(eventBookings.removedAt),
  );
}

/**
 * Upcoming shows for one site, soonest first. Null when the site does not
 * exist (or is archived), so the route can tell "no shows" from "no site".
 */
export async function listUpcomingEvents(
  db: Database,
  sitePublicId: string,
  today: string,
): Promise<ListedEvent[] | null> {
  const [site] = await db
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.publicId, sitePublicId), isNull(sites.archivedAt)))
    .limit(1);
  if (!site) return null;

  const rows = await db
    .select({
      publicId: eventBookings.publicId,
      actName: eventBookings.actName,
      genre: eventBookings.genre,
      eventDate: eventBookings.eventDate,
      startTime: eventBookings.startTime,
      isTicketed: eventBookings.isTicketed,
      logoKey: eventBookings.logoKey,
    })
    .from(eventBookings)
    .innerJoin(sites, eq(sites.id, eventBookings.siteId))
    .where(and(listed(sitePublicId), gte(eventBookings.eventDate, today)))
    // A show with no start time sorts after the timed ones on the same night.
    .orderBy(
      asc(eventBookings.eventDate),
      sql`${eventBookings.startTime} ASC NULLS LAST`,
      asc(eventBookings.actName),
    )
    .limit(MAX_EVENTS);

  return rows.map((row) => ({
    publicId: row.publicId,
    actName: row.actName,
    genre: row.genre,
    eventDate: row.eventDate!,
    startTime: row.startTime,
    isTicketed: row.isTicketed,
    hasLogo: Boolean(row.logoKey),
  }));
}

/** A listed show's stored logo, or null. */
export async function findListedEventLogo(
  db: Database,
  sitePublicId: string,
  bookingPublicId: string,
): Promise<{ key: string; contentType: string } | null> {
  const [row] = await db
    .select({ key: eventBookings.logoKey, contentType: eventBookings.logoContentType })
    .from(eventBookings)
    .innerJoin(sites, eq(sites.id, eventBookings.siteId))
    .where(and(listed(sitePublicId), eq(eventBookings.publicId, bookingPublicId)))
    .limit(1);
  return row?.key && row.contentType ? { key: row.key, contentType: row.contentType } : null;
}
