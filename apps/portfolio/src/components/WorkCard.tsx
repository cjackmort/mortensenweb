import { STATUS_LABEL, type Work } from "@/data/work";

/**
 * One portfolio entry.
 *
 * The status label is not decoration. A card that links to a live client site
 * and a card showing an unadopted concept look identical otherwise, and the
 * difference is the whole honesty of the page — so `status` is rendered for
 * every entry rather than only when it is interesting.
 */
export function WorkCard({ work }: { work: Work }) {
  const isLive = work.status === "live";

  return (
    <article className="work">
      <div className="work__media">
        {/*
          A plain <img>, and the lint rule is silenced rather than satisfied.
          `next/image` exists to optimise on request, which a static export
          cannot do — `images.unoptimized` is already set for that reason. What
          it would still add is a client component and its JavaScript, to serve
          the same bytes. The images here are cropped to the rendered size
          before they are committed (see tools/crop-card-image.ps1), which is
          the optimisation that actually applies.
        */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={work.image}
          alt={work.imageAlt}
          width={1120}
          height={700}
          loading="lazy"
          decoding="async"
        />
      </div>

      <div className="work__body">
        <p className="work__meta">
          <span className={isLive ? "status" : undefined}>
            {STATUS_LABEL[work.status]}
          </span>
          <span aria-hidden="true">·</span>
          <span>{work.sector}</span>
        </p>

        <h3 className="work__title">{work.name}</h3>
        <p className="work__desc">{work.description}</p>

        <ul className="work__tags">
          {work.tags.map((tag) => (
            <li key={tag} className="tag">
              {tag}
            </li>
          ))}
        </ul>

        <a
          className="work__link"
          href={work.href}
          target="_blank"
          // `noreferrer` as well as `noopener`: these are client sites, and
          // their analytics should not be told that this page sent the visit.
          rel="noopener noreferrer"
        >
          {work.domain}
          <span aria-hidden="true">&rarr;</span>
          <span className="hp">(opens in a new tab)</span>
        </a>
      </div>
    </article>
  );
}
