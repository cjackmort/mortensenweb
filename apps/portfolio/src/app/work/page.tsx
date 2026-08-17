import type { Metadata } from "next";
import Link from "next/link";
import { WorkCard } from "@/components/WorkCard";
import { WORK } from "@/data/work";

export const metadata: Metadata = {
  title: "Work",
  description:
    "Websites built by Mortensen Web Co. for small businesses — live sites you can visit, not mockups.",
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
            A small list, and deliberately so — everything here is a live site
            for a real business, linked so you can judge it yourself rather than
            take our word for it.
          </p>
        </div>

        <div className="work-grid">
          {WORK.map((work) => (
            <WorkCard key={work.slug} work={work} />
          ))}
        </div>
      </section>

      <section className="wrap section section--tight">
        <div className="cta">
          <h2>Yours could be next.</h2>
          <p className="lede center">
            Tell us what the business does and what the current site gets wrong.
          </p>
          <div className="btn-row">
            <Link className="btn btn--primary" href="/contact/">
              Start a project
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
