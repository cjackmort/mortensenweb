import type { Metadata } from "next";
import Link from "next/link";
import { WorkCard } from "@/components/WorkCard";
import { Reveal } from "@/components/Reveal";
import { WORK } from "@/data/work";

export const metadata: Metadata = {
  title: "Work",
  description:
    "Websites and pitch builds by Mortensen Web Co. — linked so you can visit each one yourself, labelled by whether it is a live client site or a concept build.",
  alternates: { canonical: "/work/" },
};

export default function WorkPage() {
  return (
    <>
      <section className="wrap section section--tight">
        <div className="section-head">
          <p className="eyebrow">Work</p>
          <h1>Sites we have built.</h1>
          <p className="lede">
            A small list, and deliberately so — every entry is linked so you
            can judge it yourself rather than take our word for it. Each one
            says whether it is a live client site or a concept build, and we
            do not blur the two.
          </p>
        </div>

        <div className="work-grid">
          {WORK.map((work, i) => (
            <Reveal key={work.slug} index={i}>
              <WorkCard work={work} />
            </Reveal>
          ))}
        </div>
      </section>

      <section className="wrap section section--tight">
        <Reveal>
          <div className="cta">
            <h2>Yours could be next.</h2>
            <p className="lede center">
              Tell us what the business does and what the current site gets
              wrong.
            </p>
            <div className="btn-row">
              <Link className="btn btn--primary" href="/contact/">
                Start a project
              </Link>
            </div>
          </div>
        </Reveal>
      </section>
    </>
  );
}
