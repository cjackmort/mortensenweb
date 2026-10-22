import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { requireGrowthFeature } from "@/db/repositories/client/growth";
import { listShowcases, type ShowcaseSummary } from "@/db/repositories/client/showcases";
import { formatDate } from "@/lib/time";
import { OutputPill } from "./output-pill";
import "./showcase.css";

/**
 * The client's finished jobs, newest first, with where each one has got to:
 * the website page, the social graphics and the Google post, side by side,
 * because they finish at different times and the client needs to see which
 * is still waiting on them.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Job showcase",
  robots: { index: false, follow: false },
};

export default async function ShowcaseListPage({
  searchParams,
}: {
  searchParams: Promise<{ deleted?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.organizationId) {
    return (
      <main className="shell">
        <p className="notice">Your account is not linked to an organization yet. Please contact us.</p>
      </main>
    );
  }

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  if (!(await requireGrowthFeature(db, ctx, "showcase"))) redirect("/dashboard/growth?locked=showcase#showcase");
  const [showcases, { deleted }] = await Promise.all([listShowcases(db, ctx), searchParams]);

  return (
    <main className="shell">
      <div className="masthead">
        <h1>Job showcase</h1>
        <span>Your finished work, on your site, on Google and on social</span>
      </div>

      {deleted === "1" && (
        <p className="notice notice-success">
          Removed from this list. Anything already on your website stays there.
        </p>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2>Your jobs</h2>
          {!ctx.impersonating && (
            <Link className="button small" href="/dashboard/growth/showcase/new">
              Show off a job
            </Link>
          )}
        </div>

        {showcases.length === 0 ? (
          <div className="empty">
            <p className="empty-title">Nothing here yet.</p>
            <p>
              Pick a few photos of a job you&rsquo;ve finished and say what it was. We draft the words, you
              check them, and it becomes a page on your website, a Google post and graphics for social media.
            </p>
            {!ctx.impersonating && (
              <Link className="button" href="/dashboard/growth/showcase/new">
                Show off a job
              </Link>
            )}
          </div>
        ) : (
          <ul className="showcase-list">
            {showcases.map((s) => (
              <li key={s.publicId}>
                <ShowcaseRow showcase={s} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function ShowcaseRow({ showcase }: { showcase: ShowcaseSummary }) {
  const draft = showcase.status === "draft";
  return (
    <Link className="showcase-row" href={`/dashboard/growth/showcase/${showcase.publicId}`}>
      {showcase.coverAssetPublicId ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="showcase-row-cover"
          src={`/api/media/assets/${showcase.coverAssetPublicId}/thumb`}
          alt=""
          loading="lazy"
        />
      ) : (
        <span className="showcase-row-cover" aria-hidden="true" />
      )}
      <span className="showcase-row-body">
        <span className="showcase-row-title">{showcase.title}</span>
        <span className="showcase-row-meta">
          {showcase.town} · {formatDate(showcase.approvedAt ?? showcase.createdAt)}
        </span>
        {draft ? (
          <span className="showcase-outputs">
            <span className="pill pill-accent">Check the wording</span>
          </span>
        ) : (
          <span className="showcase-outputs">
            <OutputPill name="Website" label={showcase.site.label} tone={siteTone(showcase.site.state)} />
            <OutputPill
              name="Graphics"
              label={showcase.graphicsReady ? "Ready" : "Photo missing"}
              tone={showcase.graphicsReady ? "success" : "warning"}
            />
            <OutputPill name="Google" label={showcase.google.label} tone={googleTone(showcase.google.state)} />
          </span>
        )}
      </span>
    </Link>
  );
}

function siteTone(state: ShowcaseSummary["site"]["state"]) {
  if (state === "live") return "success" as const;
  if (state === "preview_ready") return "accent" as const;
  if (state === "blocked" || state === "stopped") return "warning" as const;
  return "info" as const;
}

function googleTone(state: ShowcaseSummary["google"]["state"]) {
  if (state === "posted") return "success" as const;
  if (state === "failed") return "warning" as const;
  return "neutral" as const;
}
