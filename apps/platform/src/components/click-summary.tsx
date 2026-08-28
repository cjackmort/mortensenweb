import { BarList, StatLines } from "@/components/charts";
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
 * Because the scales differ, so does the form. Photos get bars — they are one
 * measure sorted, and length is exactly the comparison worth making. Contact
 * actions get plain figures: there are usually two of them, and a bar chart of
 * two rows is a chart pretending to have something to compare.
 *
 * The convention is a `name: detail` event label — `photo: Chief in Waiting`.
 * Encoding the subject in the name rather than in Umami's event *properties*
 * keeps this to one API call and works identically on Umami Cloud and
 * self-hosted, whose property endpoints differ.
 *
 * Renders as a *cell*, not as a card of its own: it sits inside the "What they
 * looked at" panel next to the page list, and a bordered box nested inside a
 * bordered panel is the doubled chrome this layout exists to remove.
 */

const PHOTO_PREFIX = "photo:";

function stripPrefix(label: string): string {
  const colon = label.indexOf(":");
  return colon === -1 ? label : label.slice(colon + 1).trim();
}

/** `called` reads as a log line; `Called` reads as a label. */
function sentenceCase(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
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
      <div>
        <h3>What people clicked</h3>
        <div className="empty">
          <p className="empty-title">Not measured on this site yet.</p>
          <p>
            Once we tag the photos and the call button, this shows which of your
            work people open most, and how many go on to get in touch.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h3>What people clicked</h3>

      {photos.length > 0 && (
        <>
          <BarList rows={photos} unit="opens" />
          <p className="panel-note">
            What people stop on. Worth knowing before you decide what to make
            next, or what belongs at the top of the page.
          </p>
        </>
      )}

      {actions.length > 0 && (
        <>
          <h3
            style={{
              margin: photos.length > 0 ? "1.5rem 0 0.75rem" : "0 0 0.75rem",
            }}
          >
            Getting in touch
          </h3>
          <StatLines
            rows={actions.map((a) => ({
              label: sentenceCase(a.label),
              value: a.value.toLocaleString("en-US"),
            }))}
          />
        </>
      )}
    </div>
  );
}
