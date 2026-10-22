import Link from "next/link";
import "./google-profile.css";
import type { ChecklistItem } from "@/lib/google-business/completeness";
import { describeSpecialDay, describeWeek, formatDay } from "@/lib/google-business/hours";
import type { MetricsSummary, MetricWindow, SearchSummary } from "@/lib/google-business/metrics";
import type { ProfileSnapshot } from "@/lib/google-business/types";
import { formatDate, formatDateWithYear } from "@/lib/time";

/**
 * The pieces of a Google profile both sides of the portal show: the client on
 * their Growth page, the operator in the workspace. One rendering, so the two
 * can never describe the same profile differently.
 */

const number = new Intl.NumberFormat("en-US");

export function Stars({ rating }: { rating: number | null }) {
  if (rating === null) return <span className="gp-stars muted">No rating</span>;
  const full = Math.round(rating);
  return (
    <span className="gp-stars" aria-label={`${rating} out of 5 stars`}>
      <span aria-hidden="true">
        {"★".repeat(full)}
        <span className="gp-stars-off">{"★".repeat(5 - full)}</span>
      </span>
    </span>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children ?? <span className="muted">Not on the profile</span>}</dd>
    </>
  );
}

/** Upcoming special days only; past ones are history, not something to check. */
export function upcomingSpecialDays(snapshot: ProfileSnapshot, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  return snapshot.specialHours.filter((d) => d.date >= today);
}

export function ProfileFacts({ snapshot, now }: { snapshot: ProfileSnapshot; now?: Date }) {
  const special = upcomingSpecialDays(snapshot, now);
  return (
    <dl className="detail-grid gp-facts">
      <Fact label="Name">{snapshot.title}</Fact>
      <Fact label="Category">
        {snapshot.primaryCategory ? (
          <>
            {snapshot.primaryCategory}
            {snapshot.additionalCategories.length > 0 && (
              <span className="muted"> · also {snapshot.additionalCategories.join(", ")}</span>
            )}
          </>
        ) : null}
      </Fact>
      <Fact label="Phone">{snapshot.phone}</Fact>
      <Fact label="Website">
        {snapshot.website ? (
          <a href={snapshot.website} target="_blank" rel="noreferrer">
            {snapshot.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
          </a>
        ) : null}
      </Fact>
      <Fact label="Address">{snapshot.address}</Fact>
      <Fact label="Hours">
        {snapshot.hours ? (
          <ul className="gp-hours">
            {describeWeek(snapshot.hours).map((line) => (
              <li key={line.days}>
                <span>{line.days}</span>
                <span>{line.hours}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Fact>
      <Fact label="Special hours">
        {special.length > 0 ? (
          <ul className="gp-hours">
            {special.map((day) => (
              <li key={day.date}>
                <span>{formatDay(day.date)}</span>
                <span>{describeSpecialDay(day)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="muted">None coming up</span>
        )}
      </Fact>
      <Fact label="Description">
        {snapshot.description ? <p className="gp-description">{snapshot.description}</p> : null}
      </Fact>
    </dl>
  );
}

export function Checklist({ items }: { items: ChecklistItem[] }) {
  const done = items.filter((i) => i.done).length;
  return (
    <>
      <p className="muted gp-checklist-count">
        {done} of {items.length} done
      </p>
      <ul className="gp-checklist">
        {items.map((item) => (
          <li key={item.key} className={item.done ? "is-done" : "is-open"}>
            <span className="gp-check" aria-hidden="true">
              {item.done ? "✓" : ""}
            </span>
            <span>
              <span className="gp-check-label">
                {item.label}
                <span className="sr-only">{item.done ? " — done" : " — to do"}</span>
              </span>
              <span className="gp-check-detail">{item.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Figure({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="stat">
      <p className="stat-label">{label}</p>
      <p className="stat-value">{number.format(value)}</p>
      {note ? <p className="stat-note">{note}</p> : null}
    </div>
  );
}

function monthName(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
}

export function MetricsPanel({
  metrics,
  searches,
  window,
  windowHref,
}: {
  metrics: MetricsSummary;
  searches: SearchSummary | null;
  window: MetricWindow;
  windowHref: (window: MetricWindow) => string;
}) {
  return (
    <section className="panel" aria-labelledby="gp-performance">
      <div className="panel-head">
        <h2 id="gp-performance">How people found you</h2>
        <nav className="segmented" aria-label="Period">
          {([30, 90] as const).map((w) => (
            <Link key={w} href={windowHref(w)} aria-current={w === window ? "true" : undefined}>
              {w} days
            </Link>
          ))}
        </nav>
      </div>

      {metrics.state === "none" ? (
        <div className="empty">
          <p>No figures from Google yet. They arrive with the first daily sync after the profile is linked.</p>
        </div>
      ) : (
        <div className="panel-body">
          <p className="hint gp-range">
            {formatDate(`${metrics.range.start}T12:00:00Z`)} – {formatDateWithYear(`${metrics.range.end}T12:00:00Z`)}
            {metrics.daysReported < metrics.window ? ` · Google has figures for ${metrics.daysReported} of these days` : ""}
            {" · Google's figures run a few days behind"}
          </p>
          <div className="grid grid-4 gp-figures">
            <Figure
              label="Profile views"
              value={metrics.totals.views}
              note={`${number.format(metrics.totals.searchViews)} on Search, ${number.format(metrics.totals.mapsViews)} on Maps`}
            />
            <Figure label="Calls" value={metrics.totals.calls} note="Taps on Call" />
            <Figure label="Website clicks" value={metrics.totals.websiteClicks} />
            <Figure label="Directions" value={metrics.totals.directionRequests} note="Requests for directions" />
          </div>
        </div>
      )}

      <div className="panel-body gp-searches">
        <h3 className="panel-cell-title">Searches that showed your profile</h3>
        {searches ? (
          <>
            <p>
              <strong>{searches.hasHidden ? "At least " : ""}{number.format(searches.atLeast)}</strong>{" "}
              in {searches.months.map(monthName).join(", ")}
              {searches.hasHidden ? <span className="muted"> — Google does not count searches made fewer than 15 times</span> : null}
            </p>
            {searches.top.length > 0 && (
              <ul className="statline">
                {searches.top.map((k) => (
                  <li key={k.keyword}>
                    <span className="statline-label">{k.keyword}</span>
                    <span className="statline-figure">{number.format(k.impressions ?? 0)}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="muted">No search terms from Google yet. They come monthly.</p>
        )}
      </div>
    </section>
  );
}
