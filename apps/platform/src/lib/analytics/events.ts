/**
 * What a tracked event means.
 *
 * Umami records an event as a bare string — `called`, `photo: Chief in Waiting`,
 * `work: Northwind`. Nothing in that string says whether it represents someone
 * trying to contact the business, someone browsing, or a link to another page.
 * Before this registry the dashboard guessed, and guessed wrongly: everything
 * that did not begin `photo:` was rendered under a heading reading **"Getting
 * in touch"**, so a visitor clicking a portfolio tile was reported to the
 * client as an enquiry.
 *
 * ## The rule this exists to enforce
 *
 * **An event names an action a visitor took, never an outcome the business
 * received.** Someone tapping a phone number is not a phone call; someone
 * clicking "Send" is not a submitted form; someone opening a shop link has not
 * bought anything. Every label here is written from the visitor's side, and the
 * one category that claims an outcome — `confirmed_inquiry` — can only be
 * populated from a backend record, never from a click.
 *
 * That distinction is the difference between a dashboard a client can act on
 * and one that quietly inflates their sense of how the site is doing.
 */

export type EventCategory =
  /** A visitor reached for a way to make contact. Intent, not contact. */
  | "contact_intent"
  /**
   * An enquiry the backend actually accepted.
   *
   * Never populated from a tracked click. The only sources are records we hold
   * ourselves — a form provider's submission list, or a row in our database.
   */
  | "confirmed_inquiry"
  /** A visitor looked at the work: an artwork, a project, a gallery. */
  | "content_interest"
  /** A visitor moved around the site: a service link, a portfolio tile, a CTA. */
  | "navigation"
  /** Recorded but not recognised. Shown to an operator so the registry can grow. */
  | "other";

export interface CategoryMeta {
  id: EventCategory;
  /** Heading a client sees. Never claims an outcome the data cannot support. */
  label: string;
  /** One line under the heading, saying exactly what is being counted. */
  description: string;
  /** Whether a client sees this category at all. `other` is operator-only. */
  clientVisible: boolean;
}

export const CATEGORIES: Record<EventCategory, CategoryMeta> = {
  contact_intent: {
    id: "contact_intent",
    label: "People reaching out",
    // Deliberately not "calls" or "enquiries". A tap on a phone number on a
    // desktop browser may open nothing at all.
    description:
      "Times someone tapped a phone number, an email address or a booking link. " +
      "This counts the tap, not whether a call or message followed.",
    clientVisible: true,
  },
  confirmed_inquiry: {
    id: "confirmed_inquiry",
    label: "Enquiries received",
    description:
      "Messages that actually arrived. Counted from the form's own records, " +
      "not from anyone pressing the send button.",
    clientVisible: true,
  },
  content_interest: {
    id: "content_interest",
    label: "Work people opened",
    description: "Which pieces, projects or photographs visitors opened to look at.",
    clientVisible: true,
  },
  navigation: {
    id: "navigation",
    label: "Where people went next",
    description: "Links visitors followed to move around the site.",
    clientVisible: true,
  },
  other: {
    id: "other",
    label: "Unrecognised events",
    description:
      "Events the site records that this portal has no mapping for yet. " +
      "Visible to operators so the registry can be extended.",
    clientVisible: false,
  },
};

export interface ClassifiedEvent {
  /** The raw Umami event name, unchanged. The join key back to the provider. */
  raw: string;
  /** Stable identifier for a known event; null when unmapped. */
  id: string | null;
  category: EventCategory;
  /** What a client reads. For prefixed events, the subject after the colon. */
  label: string;
  /** The subject of a prefixed event — the artwork or project name. */
  subject: string | null;
  count: number;
}

/**
 * A rule that recognises one event, or a family of them.
 *
 * `prefix` handles the `name: subject` convention the sites already use, which
 * exists so the subject travels in the event name rather than in Umami's event
 * *properties* — the property endpoints differ between Cloud and self-hosted,
 * and the name works identically on both.
 */
interface EventRule {
  id: string;
  category: EventCategory;
  /** Exact event name, lowercased. */
  match?: string;
  /** Event-name prefix, lowercased, including the colon. */
  prefix?: string;
  /** Label for an exact match. Prefixed events use their subject instead. */
  label?: string;
}

/**
 * The registry.
 *
 * Every name here is one a deployed site actually emits — taken from the
 * portfolio and the client template, not invented. Adding a site with new
 * events means adding rules here; until then those events land in `other`,
 * which is visible to operators precisely so they get noticed rather than
 * silently miscounted.
 */
export const EVENT_RULES: readonly EventRule[] = [
  // --- Contact intent ------------------------------------------------------
  // "Tapped", not "called": on a desktop browser a tel: link may do nothing,
  // and even on a phone it only opens the dialler.
  { id: "phone_tapped", category: "contact_intent", match: "called", label: "Tapped the phone number" },
  { id: "email_tapped", category: "contact_intent", match: "emailed", label: "Tapped the email address" },
  {
    id: "booking_opened",
    category: "contact_intent",
    match: "booking",
    label: "Opened the booking link",
  },
  /*
   * `enquiry sent` is a click on a submit button, and it is deliberately
   * classified as *intent* rather than as a received enquiry.
   *
   * It fires the moment the button is pressed — before validation, before the
   * POST, and regardless of whether the message ever arrives. Counting it as an
   * enquiry would tell a client they had received messages that nobody sent.
   * The real figure comes from the form provider; see `confirmed_inquiry`.
   */
  {
    id: "contact_form_submit_clicked",
    category: "contact_intent",
    match: "enquiry sent",
    label: "Pressed send on the contact form",
  },

  // --- Content interest ----------------------------------------------------
  { id: "photo_opened", category: "content_interest", prefix: "photo:" },
  { id: "artwork_opened", category: "content_interest", prefix: "artwork:" },
  { id: "project_opened", category: "content_interest", prefix: "project:" },
  { id: "gallery_opened", category: "content_interest", prefix: "gallery:" },

  // --- Navigation ----------------------------------------------------------
  // A portfolio tile is a link to another site. It is interest in the work, and
  // it is emphatically not an enquiry — which is how it used to be reported.
  { id: "work_opened", category: "navigation", prefix: "work:" },
  { id: "cta_followed", category: "navigation", prefix: "cta:" },
  { id: "service_opened", category: "navigation", prefix: "service:" },
  /*
   * An outbound shop link. Navigation, never a purchase: we see the click and
   * nothing after it, and the shop is somebody else's system.
   */
  { id: "shop_opened", category: "navigation", prefix: "shop:" },
];

/**
 * Events emitted by the portal itself, which must never appear in a client's
 * website analytics.
 *
 * The portal and the client's site are different products with different
 * audiences. A client uploading a photograph to their media library is not a
 * visitor to their own website, and counting it would inflate exactly the
 * figures they use to judge whether the site is working.
 *
 * These are filtered out by name rather than by website id as a second line of
 * defence: the ids should already differ, and if they ever do not, this still
 * keeps portal activity out of the client's report.
 */
const PORTAL_EVENT_PREFIXES = ["portal:", "media:", "request:"] as const;

export function isPortalEvent(rawName: string): boolean {
  const name = rawName.trim().toLowerCase();
  return PORTAL_EVENT_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function subjectOf(rawName: string): string | null {
  const colon = rawName.indexOf(":");
  if (colon === -1) return null;
  const subject = rawName.slice(colon + 1).trim();
  return subject.length > 0 ? subject : null;
}

/** `chief in waiting` reads as a log line; `Chief in Waiting` reads as a title. */
function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Classify one event.
 *
 * An unrecognised event becomes `other` with its raw name as the label — never
 * dropped, and never folded into a category it was not shown to belong to.
 * Silence would be worse than an ugly row: an event nobody mapped is a gap in
 * this file, and it should be visible to whoever can close it.
 */
export function classifyEvent(rawName: string, count: number): ClassifiedEvent {
  const raw = rawName.trim();
  const lower = raw.toLowerCase();

  for (const rule of EVENT_RULES) {
    if (rule.match && lower === rule.match) {
      return {
        raw,
        id: rule.id,
        category: rule.category,
        label: rule.label ?? sentenceCase(raw),
        subject: null,
        count,
      };
    }

    if (rule.prefix && lower.startsWith(rule.prefix)) {
      const subject = subjectOf(raw);
      return {
        raw,
        id: rule.id,
        category: rule.category,
        // The subject is the useful label — the client knows which piece it is.
        label: subject ? sentenceCase(subject) : sentenceCase(raw),
        subject,
        count,
      };
    }
  }

  return {
    raw,
    id: null,
    category: "other",
    label: raw,
    subject: null,
    count,
  };
}

/**
 * A backend-confirmed outcome, injected into the registry's grouping.
 *
 * The one route into `confirmed_inquiry`, and it does not go through
 * `classifyEvent` at all — nothing derived from a tracked event can reach this
 * category, which is the property the whole separation exists to guarantee.
 *
 * Callers pass counts they hold themselves: a form provider's submission list,
 * or a row in our own database. See `lib/analytics/inquiries`.
 */
export interface BackendOutcome {
  id: string;
  label: string;
  count: number;
}

export interface CategorisedEvents {
  category: EventCategory;
  meta: CategoryMeta;
  events: ClassifiedEvent[];
  /** Total occurrences in this category. Occurrences, not people. */
  total: number;
}

/**
 * Group classified events by category, largest first within each.
 *
 * Portal events are removed before anything else happens, so they cannot reach
 * a client's report by any path through this function.
 *
 * Empty categories are omitted rather than rendered as zero. "No calls this
 * month" and "we have not tagged the call button" look identical as a zero and
 * mean opposite things; the caller decides which it is from whether tracking is
 * configured at all.
 */
export function categoriseEvents(
  rows: { label: string; value: number }[],
  /**
   * Outcomes the backend confirmed, which no click may produce.
   *
   * Added after classification rather than fed through it, so there is no code
   * path by which a tracked event becomes a confirmed enquiry.
   */
  backendOutcomes: BackendOutcome[] = [],
): CategorisedEvents[] {
  const classified = rows
    .filter((row) => !isPortalEvent(row.label))
    .map((row) => classifyEvent(row.label, row.value));

  const confirmed: ClassifiedEvent[] = backendOutcomes
    .filter((outcome) => outcome.count > 0)
    .map((outcome) => ({
      raw: outcome.id,
      id: outcome.id,
      category: "confirmed_inquiry" as const,
      label: outcome.label,
      subject: null,
      count: outcome.count,
    }));

  classified.push(...confirmed);

  const order: EventCategory[] = [
    "confirmed_inquiry",
    "contact_intent",
    "content_interest",
    "navigation",
    "other",
  ];

  return order
    .map((category) => {
      const events = classified
        .filter((event) => event.category === category)
        .sort((a, b) => b.count - a.count);
      return {
        category,
        meta: CATEGORIES[category],
        events,
        total: events.reduce((sum, event) => sum + event.count, 0),
      };
    })
    .filter((group) => group.events.length > 0);
}
