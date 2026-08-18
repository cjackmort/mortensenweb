import { BarList } from "@/components/charts";
import type { Breakdown } from "@/lib/analytics/umami";

/**
 * What visitors did, as opposed to what they looked at.
 *
 * Visits, referrers and devices describe an audience. This describes intent:
 * which sculpture someone opened, whether they went on to call. For a client
 * the second question is the one worth money, and until now the dashboard
 * could not answer it at all.
 *
 * Events are split into two lists because they answer different questions and
 * are on different scales. Photographs are opened constantly; calls are rare
 * and precious. Ranking them together buries every call under a gallery, and a
 * client scanning the page would conclude nobody ever rang.
 *
 * The convention is a `name: detail` event label — `photo: Chief in Waiting`.
 * Encoding the subject in the name rather than in Umami's event *properties*
 * keeps this to one API call and works identically on Umami Cloud and
 * self-hosted, whose property endpoints differ.
 */

const PHOTO_PREFIX = "photo:";

function stripPrefix(label: string): string {
  const colon = label.indexOf(":");
  return colon === -1 ? label : label.slice(colon + 1).trim();
}

export function ClickSummary({ events }: { events: Breakdown[] }) {
  const photos = events
    .filter((e) => e.label.toLowerCase().startsWith(PHOTO_PREFIX))
    .map((e) => ({ label: stripPrefix(e.label), value: e.value }));

  const actions = events
    .filter((e) => !e.label.toLowerCase().startsWith(PHOTO_PREFIX))
    .map((e) => ({ label: stripPrefix(e.label), value: e.value }));

  // Nothing recorded is a setup state, not a zero. A site that has never
  // emitted an event has not been marked up yet, and telling a client "0
  // clicks" would be reporting a fact about our configuration as though it
  // were a fact about their business.
  if (events.length === 0) {
    return (
      <section className="card">
        <div className="card-head">
          <h2>What people clicked</h2>
        </div>
        <div className="empty">
          <p className="empty-title">Not measured on this site yet.</p>
          <p>
            Once we tag the photos and the call button, this shows which of your
            work people open most, and how many go on to get in touch.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>What people clicked</h2>
        <span className="muted">last 30 days</span>
      </div>

      {photos.length > 0 && (
        <>
          <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.5rem" }}>
            Most-opened photos
          </h3>
          <BarList rows={photos} unit="opens" />
          <p className="muted" style={{ fontSize: "0.8rem", margin: "0.6rem 0 1.25rem" }}>
            What people stop on. Worth knowing before you decide what to make
            next, or what belongs at the top of the page.
          </p>
        </>
      )}

      {actions.length > 0 && (
        <>
          <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.5rem" }}>
            Getting in touch
          </h3>
          <BarList rows={actions} unit="times" />
        </>
      )}
    </section>
  );
}
