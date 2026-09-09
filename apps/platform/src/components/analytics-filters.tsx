import Link from "next/link";
import { CATEGORIES, type EventCategory } from "@/lib/analytics/events";
import {
  hasActiveFilters,
  serialiseFilters,
  type AnalyticsFilters,
} from "@/lib/analytics/filters";

/**
 * The filter controls, and — more importantly — what is currently filtered.
 *
 * A plain GET form. The selects carry the provider's own parameter names, the
 * browser assembles the query string, and the page re-renders on the server.
 * No JavaScript, no client-side fetching, and nothing to debounce: choosing
 * three filters and pressing Apply is **one** request rather than three, which
 * is what the brief means by avoiding unnecessary requests during filter
 * changes.
 *
 * It also degrades honestly. With scripting off this still works, because there
 * is nothing here that scripting was doing.
 *
 * ## Two things this must never do
 *
 * **Offer a control that does nothing.** Every option maps to a filter Umami
 * actually supports — the list came from their filter schema, not from
 * guesswork. A dimension with no values in the period renders disabled with the
 * reason, rather than as an empty dropdown that looks broken.
 *
 * **Hide what is active.** The chips are not decoration. A client reading a
 * figure needs to know it covers mobile visitors from Google only, and a filter
 * chosen three screens up is otherwise invisible by the time they reach the
 * number it changed.
 */

const EVENT_CATEGORY_OPTIONS: EventCategory[] = [
  "contact_intent",
  "content_interest",
  "navigation",
];

export function AnalyticsFilterBar({
  filters,
  basePath,
  devices,
  referrers,
  pages,
}: {
  filters: AnalyticsFilters;
  basePath: string;
  /** Values seen in this period, so no option is offered that matches nothing. */
  devices: string[];
  referrers: string[];
  pages: string[];
}) {
  const withoutOne = (next: Partial<AnalyticsFilters>) =>
    `${basePath}${serialiseFilters({ ...filters, ...next })}`;

  const chips = [
    filters.path && {
      label: `Page: ${filters.path}`,
      clearHref: withoutOne({ path: undefined }),
    },
    filters.referrer && {
      label: `Source: ${filters.referrer}`,
      clearHref: withoutOne({ referrer: undefined }),
    },
    filters.device && {
      label: `Device: ${filters.device}`,
      clearHref: withoutOne({ device: undefined }),
    },
    filters.country && {
      label: `Country: ${filters.country}`,
      clearHref: withoutOne({ country: undefined }),
    },
    filters.utmCampaign && {
      label: `Campaign: ${filters.utmCampaign}`,
      clearHref: withoutOne({ utmCampaign: undefined }),
    },
    filters.eventCategory && {
      label: `Actions: ${CATEGORIES[filters.eventCategory].label}`,
      clearHref: withoutOne({ eventCategory: undefined }),
    },
  ].filter((chip): chip is { label: string; clearHref: string } => Boolean(chip));

  return (
    <div className="filter-bar">
      <form method="get" action={basePath} className="filter-row">
        {/*
         * The range travels with the form so choosing a device does not silently
         * reset the period back to thirty days — the sort of thing that makes a
         * filter bar feel broken without ever erroring.
         */}
        {filters.range !== 30 && (
          <input type="hidden" name="range" value={String(filters.range)} />
        )}
        {filters.range === "custom" && filters.customStart && (
          <input type="hidden" name="from" value={filters.customStart} />
        )}
        {filters.range === "custom" && filters.customEnd && (
          <input type="hidden" name="to" value={filters.customEnd} />
        )}
        {!filters.compare && <input type="hidden" name="compare" value="off" />}
        {filters.country && (
          <input type="hidden" name="country" value={filters.country} />
        )}
        {filters.utmCampaign && (
          <input type="hidden" name="utm_campaign" value={filters.utmCampaign} />
        )}

        <FilterSelect
          id="filter-page"
          name="path"
          label="Page"
          value={filters.path}
          options={pages}
        />
        <FilterSelect
          id="filter-source"
          name="referrer"
          label="Source"
          value={filters.referrer}
          options={referrers}
        />
        <FilterSelect
          id="filter-device"
          name="device"
          label="Device"
          value={filters.device}
          options={devices}
        />
        <FilterSelect
          id="filter-events"
          name="events"
          label="Actions"
          value={filters.eventCategory}
          options={EVENT_CATEGORY_OPTIONS}
          labelFor={(value) => CATEGORIES[value as EventCategory].label}
          // Said on the control, not only in the panel it governs. A filter
          // that quietly applies to part of a page is worse than no filter.
          note="this panel only"
        />

        <button type="submit" className="secondary">
          Apply
        </button>
      </form>

      {chips.length > 0 && (
        <div className="filter-chips">
          <span className="muted">Showing only:</span>
          {chips.map((chip) => (
            <Link key={chip.label} href={chip.clearHref} className="filter-chip">
              {chip.label}
              <span aria-hidden="true"> ×</span>
              <span className="sr-only"> — remove this filter</span>
            </Link>
          ))}
        </div>
      )}

      {hasActiveFilters(filters) && (
        <p className="filter-reset">
          <Link href={basePath}>Clear all filters</Link>
        </p>
      )}
    </div>
  );
}

/**
 * One dimension, as a native select.
 *
 * Disabled with the reason when the period produced nothing to filter by. An
 * empty dropdown reads as a bug; "No data in this period" reads as a fact about
 * the data, which is what it is.
 */
function FilterSelect({
  id,
  name,
  label,
  value,
  options,
  labelFor,
  note,
}: {
  id: string;
  name: string;
  label: string;
  value: string | undefined;
  options: string[];
  labelFor?: (value: string) => string;
  note?: string;
}) {
  const empty = options.length === 0;

  return (
    <div className="filter-field">
      <label htmlFor={id}>
        {label}
        {note && <span className="muted"> ({note})</span>}
      </label>
      <select id={id} name={name} defaultValue={value ?? ""} disabled={empty}>
        {empty ? (
          <option value="">No data in this period</option>
        ) : (
          <>
            <option value="">All</option>
            {options.map((option) => (
              <option key={option} value={option}>
                {labelFor ? labelFor(option) : option}
              </option>
            ))}
          </>
        )}
      </select>
    </div>
  );
}
