/**
 * Loading states that hold the shape of what is coming.
 *
 * Every portal route is server-rendered on demand, so a tap on a tab used to
 * do nothing visible until the whole page came back — on a cold function and
 * a cold database that is seconds of a dead button. These render instantly
 * from the route's `loading.tsx` and are replaced in place when the page
 * streams in. They are the same panels at the same sizes, so the swap does not
 * shift anything; a spinner in the middle of a blank page would.
 *
 * `aria-busy` on the container and `aria-hidden` on the bones: a screen reader
 * hears "loading" once rather than a list of empty boxes.
 */

function Bone({
  w = "100%",
  h = "0.9rem",
  className = "",
}: {
  w?: string;
  h?: string;
  className?: string;
}) {
  return (
    <span
      className={`bone ${className}`.trim()}
      style={{ width: w, height: h }}
      aria-hidden="true"
    />
  );
}

export function MastheadSkeleton({ title }: { title: string }) {
  return (
    <div className="masthead">
      <h1>{title}</h1>
    </div>
  );
}

/** The visitors panel: four metrics and a chart-height block. */
export function VisitorsSkeleton() {
  return (
    <section className="panel" aria-busy="true" aria-label="Loading visitors">
      <div className="panel-head">
        <h2>Your visitors</h2>
        <Bone w="9rem" h="1.6rem" />
      </div>
      <div className="metrics">
        {[0, 1, 2, 3].map((i) => (
          <div className="metric" key={i}>
            <Bone w="4.5rem" h="0.7rem" />
            <Bone w="5.5rem" h="1.8rem" className="bone-gap" />
            <Bone w="6rem" h="0.7rem" />
          </div>
        ))}
      </div>
      <div className="panel-body">
        <Bone h="clamp(9rem, 30vw, 13rem)" />
      </div>
    </section>
  );
}

/** A panel with a head and N text rows — requests, billing lines, tables. */
export function ListSkeleton({
  title,
  rows = 3,
}: {
  title: string;
  rows?: number;
}) {
  return (
    <section className="panel" aria-busy="true" aria-label={`Loading ${title}`}>
      <div className="panel-head">
        <h2>{title}</h2>
      </div>
      <div className="panel-body">
        {Array.from({ length: rows }, (_, i) => (
          <div className="bone-row" key={i}>
            <Bone w={`${55 + ((i * 17) % 35)}%`} h="1rem" />
            <Bone w="30%" h="0.75rem" />
          </div>
        ))}
      </div>
    </section>
  );
}

/** A grid of tiles — the admin client grid. */
export function TileSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="site-grid" aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <div className="site-card" key={i}>
          <div className="site-card-media bone" />
          <div className="site-card-body">
            <Bone w="60%" h="1rem" />
            <Bone w="40%" h="0.75rem" />
          </div>
        </div>
      ))}
    </div>
  );
}
