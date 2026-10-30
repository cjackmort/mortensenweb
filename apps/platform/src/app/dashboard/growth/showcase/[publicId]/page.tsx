import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { requireGrowthFeature } from "@/db/repositories/client/growth";
import { getShowcase, type ShowcaseDetail } from "@/db/repositories/client/showcases";
import { GOOGLE_IMAGE, GRAPHIC_FORMATS } from "@/lib/showcase/formats";
import { formatDate } from "@/lib/time";
import { OutputPill } from "../output-pill";
import {
  CopyButton,
  DeleteShowcaseForm,
  MarkPostedButton,
  SendToSiteButton,
  WordingForm,
} from "./controls";
import "../showcase.css";

/**
 * One showcase. While it is a draft, this is where the client reads the
 * wording the portal drafted and approves it. Once approved, it is where each
 * output is: the website page's progress, the graphics to download, and the
 * Google post — posted for them where a connection exists, otherwise laid out
 * ready to paste.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Job showcase",
  robots: { index: false, follow: false },
};

const ROLE_LABEL = { before: "Before", after: "After", photo: null } as const;

export default async function ShowcasePage({ params }: { params: Promise<{ publicId: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.organizationId) notFound();

  const { publicId } = await params;
  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  if (!(await requireGrowthFeature(db, ctx, "showcase"))) redirect("/dashboard/growth?locked=showcase#showcase");

  let showcase: ShowcaseDetail;
  try {
    showcase = await getShowcase(db, ctx, publicId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const readOnly = ctx.impersonating;
  const draft = showcase.status === "draft";

  return (
    <main className="shell">
      <div className="masthead">
        <h1>{showcase.title}</h1>
        <span>
          <Link href="/dashboard/growth/showcase">Job showcase</Link> · {showcase.town}
        </span>
      </div>

      {/* Only when there is something in it: a photo purged from the library
          leaves the showcase with it, and an empty strip drew a blank box. */}
      {showcase.photos.length > 0 && (
        <section className="panel">
          <div className="panel-body">
            <ul className="showcase-photos">
              {showcase.photos.map((photo) => (
                <li key={photo.assetPublicId} className={photo.usable ? undefined : "is-missing"}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/media/assets/${photo.assetPublicId}/thumb`} alt={photo.title} loading="lazy" />
                  {ROLE_LABEL[photo.role] && <span className="pill pill-neutral">{ROLE_LABEL[photo.role]}</span>}
                  {!photo.usable && <span className="showcase-photo-note">No longer in your library</span>}
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {draft ? <DraftPanel showcase={showcase} readOnly={readOnly} /> : <Outputs showcase={showcase} readOnly={readOnly} />}

      <div className="showcase-foot">
        <DeleteShowcaseForm publicId={showcase.publicId} readOnly={readOnly} />
      </div>
    </main>
  );
}

function DraftPanel({ showcase, readOnly }: { showcase: ShowcaseDetail; readOnly: boolean }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Check the wording</h2>
        <span className="pill pill-accent">Draft</span>
      </div>
      <div className="panel-body">
        <p className="panel-note showcase-source">
          Drafted from what you told us — <em>{showcase.job}</em>, in {showcase.town}
          {showcase.notes ? <>, and &ldquo;{showcase.notes}&rdquo;</> : null} — and your business details.
          Change anything that isn&rsquo;t right. Nothing is published until you approve it.
        </p>
        <WordingForm
          publicId={showcase.publicId}
          title={showcase.title}
          writeUp={showcase.writeUp}
          caption={showcase.caption}
          readOnly={readOnly}
        />
      </div>
    </section>
  );
}

function Outputs({ showcase, readOnly }: { showcase: ShowcaseDetail; readOnly: boolean }) {
  const base = `/dashboard/growth/showcase/${showcase.publicId}`;
  const site = showcase.site;

  return (
    <>
      <section className="panel" id="website">
        <div className="panel-head">
          <h2>Website page</h2>
          <OutputPill
            name="Website"
            label={site.label}
            tone={site.state === "live" ? "success" : site.state === "preview_ready" ? "accent" : site.state === "blocked" || site.state === "stopped" ? "warning" : "info"}
          />
        </div>
        <div className="panel-body">
          <p>{site.detail}</p>
          {showcase.siteName && <p className="field-hint">Going on {showcase.siteName}.</p>}
          <div className="actions">
            {showcase.requestPublicId && (
              <Link className="button secondary small" href="/dashboard/requests">
                See it under Requests
              </Link>
            )}
            {site.canSend && <SendToSiteButton publicId={showcase.publicId} readOnly={readOnly} />}
          </div>
        </div>
      </section>

      <section className="panel" id="graphics">
        <div className="panel-head">
          <h2>Social graphics</h2>
          <OutputPill
            name="Graphics"
            label={showcase.graphicsReady ? "Ready" : "Photo missing"}
            tone={showcase.graphicsReady ? "success" : "warning"}
          />
        </div>
        <div className="panel-body">
          {showcase.graphicsReady ? (
            <>
              <ul className="showcase-graphics">
                {GRAPHIC_FORMATS.map((format) => (
                  <li key={format.key}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`${base}/graphics/${format.key}`}
                      alt={`${format.label} graphic: ${showcase.title}`}
                      width={format.width}
                      height={format.height}
                      loading="lazy"
                    />
                    <span className="showcase-graphic-label">
                      <strong>{format.label}</strong> {format.width}×{format.height}
                      <span className="muted"> · {format.use}</span>
                    </span>
                    <a className="button secondary small" href={`${base}/graphics/${format.key}?download=1`}>
                      Download
                    </a>
                  </li>
                ))}
              </ul>
              <div className="actions">
                <a className="button small" href={`${base}/zip`}>
                  Download all (zip)
                </a>
              </div>
              {!showcase.brand.fromProfile && (
                <p className="field-hint">
                  These use dark grey because your business details don&rsquo;t have brand colours yet. Send us
                  your colours (for example #1F3A5F) and every graphic will use them.
                </p>
              )}
              <h3 className="showcase-subhead">Suggested caption</h3>
              <p className="showcase-copy">{showcase.caption}</p>
              <CopyButton text={showcase.caption} label="Copy caption" />
            </>
          ) : (
            <p>None of this job&rsquo;s photos are in your library any more, so there is nothing to make graphics from.</p>
          )}
        </div>
      </section>

      <section className="panel" id="google">
        <div className="panel-head">
          <h2>Google post</h2>
          <OutputPill
            name="Google"
            label={showcase.google.label}
            tone={showcase.google.state === "posted" ? "success" : showcase.google.state === "failed" ? "warning" : "neutral"}
          />
        </div>
        <div className="panel-body">
          {showcase.google.state === "posted" ? (
            <p>On your Google Business Profile.</p>
          ) : (
            <GoogleManual showcase={showcase} base={base} readOnly={readOnly} />
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Approved wording</h2>
          {showcase.approvedAt && <span className="muted">{formatDate(showcase.approvedAt)}</span>}
        </div>
        <div className="panel-body">
          <p className="showcase-copy">{showcase.writeUp}</p>
        </div>
      </section>
    </>
  );
}

function GoogleManual({ showcase, base, readOnly }: { showcase: ShowcaseDetail; base: string; readOnly: boolean }) {
  const post = showcase.googlePost;
  return (
    <>
      {showcase.google.state === "failed" ? (
        <p className="notice">
          Google didn&rsquo;t take the post{showcase.googleError ? ` (${showcase.googleError})` : ""}. You can post it
          yourself instead.
        </p>
      ) : (
        <p>
          Your Google Business Profile isn&rsquo;t connected to the portal yet, so post this one yourself. It takes
          a minute.
        </p>
      )}
      <ol className="showcase-steps">
        <li>Open your Business Profile on Google (search for your business name while signed in).</li>
        <li>Choose <strong>Add update</strong>.</li>
        <li>Paste the text below and add the photo.</li>
        {post.cta?.actionType === "CALL" && (
          <li>
            Set the button to <strong>Call now</strong>.
          </li>
        )}
        {post.cta && post.cta.actionType !== "CALL" && (
          <li>
            Set the button to <strong>Book</strong> and paste {post.cta.url}.
          </li>
        )}
      </ol>
      <p className="showcase-copy">{post.summary}</p>
      <div className="actions">
        <CopyButton text={post.summary} label="Copy post text" />
        <a className="button secondary small" href={`${base}/graphics/${GOOGLE_IMAGE.key}?download=1`}>
          Download photo ({GOOGLE_IMAGE.width}×{GOOGLE_IMAGE.height})
        </a>
        <MarkPostedButton publicId={showcase.publicId} readOnly={readOnly} />
      </div>
    </>
  );
}
