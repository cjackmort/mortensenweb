import { BarList, StatLines } from "@/components/charts";
import {
  categoriseEvents,
  type CategorisedEvents,
  type EventCategory,
} from "@/lib/analytics/events";
import { shareOf } from "@/lib/analytics/metrics";

/**
 * What visitors did, grouped by what it actually means.
 *
 * Replaces a component that split events into "photos" and everything else,
 * and titled everything else **"Getting in touch"**. A visitor clicking a
 * portfolio tile was therefore reported to the client as someone trying to
 * make contact, which is the single most misleading thing this dashboard did.
 *
 * Grouping now comes from `lib/analytics/events`, where each category is
 * documented and every label is written from the visitor's side. Nothing here
 * decides what an event means; it only renders the decision.
 */

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * Occurrences, stated as occurrences.
 *
 * "12 taps" rather than "12 people": one visitor tapping a number three times
 * makes three. Saying "people" would be a claim the data cannot support, and
 * it is the claim that turns into an invented conversion rate one step later.
 */
function occurrenceNote(total: number): string {
  return total === 1 ? "1 time in total" : `${formatCount(total)} times in total`;
}

function CategoryPanel({
  group,
  denominator,
}: {
  group: CategorisedEvents;
  /** All classified occurrences, so shares can name what they are shares of. */
  denominator: number;
}) {
  const { meta, events, total } = group;

  // A bar list compares magnitudes and needs several rows to be worth drawing.
  // Two rows of bars is a chart pretending to have something to compare.
  const useBars = events.length >= 3;

  return (
    <section className="event-panel">
      <h3>{meta.label}</h3>
      <p className="panel-note">{meta.description}</p>

      {useBars ? (
        <BarList
          rows={events.map((event) => ({ label: event.label, value: event.count }))}
          unit="times"
        />
      ) : (
        <StatLines
          rows={events.map((event) => ({
            label: event.label,
            value: formatCount(event.count),
          }))}
        />
      )}

      <p className="panel-note">
        {occurrenceNote(total)}
        {denominator > 0 && (
          <>
            {" — "}
            {/* The denominator is stated rather than implied. A share of all
                tracked activity and a share of the rows on screen are different
                claims, and a reader cannot tell them apart from a bare %. */}
            {Math.round((shareOf(total, denominator, "all_activity").fraction ?? 0) * 100)}%
            {" of everything we track on this site."}
          </>
        )}
      </p>
    </section>
  );
}

export function EventPanels({
  events,
  /** Narrows these panels only. Named in the UI, because it governs part of a page. */
  categoryFilter,
  /** True when the site has never emitted an event, as opposed to none this period. */
  trackingConfigured,
  isAdmin = false,
}: {
  events: { label: string; value: number }[];
  categoryFilter?: EventCategory;
  trackingConfigured: boolean;
  isAdmin?: boolean;
}) {
  const groups = categoriseEvents(events).filter(
    (group) => group.meta.clientVisible || isAdmin,
  );

  const denominator = groups.reduce((sum, group) => sum + group.total, 0);

  const shown = categoryFilter
    ? groups.filter((group) => group.category === categoryFilter)
    : groups;

  /*
   * Three different emptinesses, three different messages.
   *
   * Collapsing them was one of the confirmed faults: an empty event list was
   * rendered as "not measured on this site yet", which told a client with a
   * fully tagged site and a quiet fortnight that their tracking was broken.
   */
  if (groups.length === 0) {
    return (
      <div className="empty">
        <p className="empty-title">
          {trackingConfigured
            ? "Nothing was clicked in this period."
            : "Not measured on this site yet."}
        </p>
        <p>
          {trackingConfigured
            ? "The site is recording clicks — there were none in this window. Try a longer period."
            : "Once we tag the photos and the call button, this shows which of your work people open most, and how many go on to get in touch."}
        </p>
      </div>
    );
  }

  if (shown.length === 0) {
    // Filtered to nothing. A distinct state from "no activity", because the
    // useful next action is to clear the filter rather than to wait.
    return (
      <div className="empty">
        <p className="empty-title">Nothing in this category for this period.</p>
        <p>Other categories have activity — clear the event filter to see them.</p>
      </div>
    );
  }

  return (
    <div className="event-panels">
      {categoryFilter && (
        <p className="notice" style={{ marginTop: 0 }}>
          Showing one category. This filter applies to these panels only — the
          visitor figures above cover everything.
        </p>
      )}

      {shown.map((group) => (
        <CategoryPanel key={group.category} group={group} denominator={denominator} />
      ))}
    </div>
  );
}
