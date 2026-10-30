import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import { getGoogleConnectionStatus, type GoogleConnectionStatus } from "@/db/repositories/admin/google-connection";
import { getGoogleQueue, listGoogleClients, listLinkableLocations, type LinkableLocations } from "@/db/repositories/admin/google-profile";
import { Stars } from "@/components/google-profile";
import { expectedRedirectUri } from "@/lib/google-business/config";
import { describeGoogleError } from "@/lib/google-business/errors";
import { formatDateTime, formatDateWithYear } from "@/lib/time";
import { ActionForm } from "./action-form";
import { acceptInvitationAction, checkAccessAction, disconnectAction } from "./actions";

/**
 * Google profile management, the operator's home: whether the agency's Google
 * connection works (and if not, exactly what is missing), manager invitations
 * waiting to be accepted, and the queue across every client — unanswered
 * reviews, stale posts, profile gaps, and what clients have asked for.
 *
 * Gated twice like every admin page: the layout, and the role check here.
 */

export const dynamic = "force-dynamic";

export const metadata = { title: "Google profiles", robots: { index: false, follow: false } };

const CONNECT_NOTICE: Record<string, { tone: string; text: string }> = {
  connected: { tone: "notice-success", text: "Google is connected." },
  no_access: {
    tone: "notice-info",
    text: "Signed in with Google, but Google has not granted this project Business Profile API access yet. See below.",
  },
  denied: { tone: "notice-danger", text: "Google's consent screen was cancelled. Nothing was connected." },
  expired: { tone: "notice-danger", text: "That sign-in had expired or did not start here. Connect again." },
  failed: { tone: "notice-danger", text: "Google did not complete the connection. Connect again; the server log has the reason." },
  not_configured: { tone: "notice-danger", text: "Set the Google environment variables first (see the checklist)." },
};

export default async function GoogleAdminPage({ searchParams }: { searchParams: Promise<{ connect?: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");
  const ctx = adminContextFrom(user);
  const db = await getDb();

  const [status, queue, clients, params] = await Promise.all([
    getGoogleConnectionStatus(db),
    getGoogleQueue(ctx, db),
    listGoogleClients(ctx, db),
    searchParams,
  ]);
  const notice = params.connect ? CONNECT_NOTICE[params.connect] : null;

  // Live from Google, and only when it can answer: one call per account.
  let linkable: LinkableLocations | null = null;
  let linkableError: string | null = null;
  if (status.state === "connected" && !status.pausedUntil) {
    try {
      linkable = await listLinkableLocations(ctx, db);
    } catch (error) {
      linkableError = describeGoogleError(error);
    }
  }

  const withFeature = clients.filter((c) => c.hasFeature || c.location);

  return (
    <main className="shell">
      <div className="masthead">
        <h1>Google profiles</h1>
        <span className="muted">Posts, hours, photos and review replies for every client</span>
      </div>

      {notice && <p className={`notice ${notice.tone}`}>{notice.text}</p>}

      <ConnectionPanel status={status} />

      {linkable && linkable.invitations.length > 0 && (
        <section className="panel" aria-labelledby="gp-invites">
          <div className="panel-head">
            <h2 id="gp-invites">Manager invitations</h2>
            <span className="panel-sub">Clients who added the agency on Google</span>
          </div>
          <div className="panel-body">
            <ul className="gp-queue-list">
              {linkable.invitations.map((invite) => (
                <li key={invite.name}>
                  <span className="gp-queue-what">
                    <strong>{invite.target}</strong>
                    <p>As {invite.role.toLowerCase().replace(/_/g, " ") || "manager"}</p>
                  </span>
                  <ActionForm action={acceptInvitationAction} hidden={{ invitation: invite.name }} buttons={[{ label: "Accept", value: "accept", pendingLabel: "Accepting…" }]} />
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
      {linkableError && <p className="notice notice-danger">Could not read manager invitations: {linkableError}</p>}

      <Queue queue={queue} />

      <section className="panel" aria-labelledby="gp-clients">
        <div className="panel-head">
          <h2 id="gp-clients">Clients</h2>
          <span className="panel-sub">Those whose plan includes Google profile management</span>
        </div>
        {withFeature.length === 0 ? (
          <div className="empty">
            <p>No client has Google profile management yet. It comes with Pro, or as an add-on from a client&rsquo;s Billing section.</p>
          </div>
        ) : (
          <div className="panel-body">
            <div className="table-wrap">
              <table className="stack">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Google profile</th>
                    <th>Last synced</th>
                  </tr>
                </thead>
                <tbody>
                  {withFeature.map((c) => (
                    <tr key={c.clientPublicId}>
                      <td data-label="Client">
                        <Link href={`/admin/google/${c.clientPublicId}`}>{c.organizationName}</Link>
                        {c.isDemo && (
                          <>
                            {" "}
                            <span className="badge">Demo</span>
                          </>
                        )}
                        {!c.hasFeature && <span className="muted"> · not in their plan</span>}
                      </td>
                      <td data-label="Google profile">{c.location ? (c.location.title ?? c.location.locationName) : <span className="muted">Not linked</span>}</td>
                      <td data-label="Last synced">
                        {c.location?.lastSyncError ? (
                          <span className="gp-change-failed">Failing</span>
                        ) : c.location?.lastSyncedAt ? (
                          formatDateTime(c.location.lastSyncedAt)
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------

function Step({ done, children }: { done: boolean | null; children: React.ReactNode }) {
  return (
    <li className={done ? "is-done" : "is-open"}>
      <span className="gp-check" aria-hidden="true">
        {done ? "✓" : ""}
      </span>
      <span>
        {children}
        <span className="sr-only">{done ? " — done" : done === false ? " — to do" : " — check in Google Cloud"}</span>
      </span>
    </li>
  );
}

function SetupChecklist({ status }: { status: GoogleConnectionStatus }) {
  const missing = status.state === "not_configured" ? status.missing : [];
  // From the configuration rather than the status: it is the value to
  // register with Google whatever state the connection is in.
  const redirectUri = expectedRedirectUri();
  const connected = status.state !== "not_configured" && status.state !== "not_connected";
  const hasAccess = status.state === "connected";

  return (
    <ol className="gp-checklist gp-setup">
      <Step done={hasAccess ? true : null}>
        <span className="gp-check-label">A Google Cloud project with the Business Profile APIs enabled</span>
        <span className="gp-check-detail">
          My Business Account Management, My Business Business Information, Business Profile Performance, and Google My
          Business (v4, for reviews, posts and photos).
        </span>
      </Step>
      <Step done={hasAccess ? true : status.state === "no_access" ? false : null}>
        <span className="gp-check-label">Business Profile API access approved by Google</span>
        <span className="gp-check-detail">
          Requested through Google&rsquo;s access form (see{" "}
          <a href="https://developers.google.com/my-business/content/prereqs" target="_blank" rel="noreferrer">
            the prerequisites
          </a>
          ); Google takes days and wants a profile verified for 60 days or more. Until then the quota is 0 requests a
          minute; approved projects get 300.
        </span>
      </Step>
      <Step done={null}>
        <span className="gp-check-label">OAuth consent screen published, scope business.manage</span>
        <span className="gp-check-detail">
          In Testing mode Google expires the refresh token after 7 days and the connection needs redoing. Publishing needs
          a privacy policy page.
        </span>
      </Step>
      <Step done={!missing.includes("GOOGLE_CLIENT_ID") && !missing.includes("GOOGLE_CLIENT_SECRET")}>
        <span className="gp-check-label">
          Web OAuth client, as <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>
        </span>
        <span className="gp-check-detail">
          Authorised redirect URI: <code>{redirectUri ?? "set AUTH_URL or GOOGLE_REDIRECT_URI"}</code>
        </span>
      </Step>
      <Step done={!missing.includes("GOOGLE_TOKEN_KEY")}>
        <span className="gp-check-label">
          <code>GOOGLE_TOKEN_KEY</code> set
        </span>
        <span className="gp-check-detail">
          Seals the refresh token in the database. 32 random bytes: <code>openssl rand -base64 32</code>. Changing it
          later means connecting again.
        </span>
      </Step>
      <Step done={connected}>
        <span className="gp-check-label">The agency&rsquo;s Google account connected here</span>
      </Step>
      <Step done={null}>
        <span className="gp-check-label">Each client adds that account as a Manager on their profile</span>
        <span className="gp-check-detail">Their Growth page shows them how. Accept the invitation here, then link the profile on the client&rsquo;s page.</span>
      </Step>
    </ol>
  );
}

function ConnectionPanel({ status }: { status: GoogleConnectionStatus }) {
  const heading =
    status.state === "connected"
      ? "Connected"
      : status.state === "no_access"
        ? "Connected, without API access"
        : status.state === "needs_reconnect"
          ? "Needs reconnecting"
          : "Not connected";
  const pill =
    status.state === "connected" ? "pill-success" : status.state === "no_access" || status.state === "needs_reconnect" ? "pill-warning" : "pill-neutral";

  return (
    <>
      <section className="panel" aria-labelledby="gp-connection">
        <div className="panel-head">
          <h2 id="gp-connection">Google connection</h2>
          <span className={`pill ${pill}`}>{heading}</span>
        </div>
        <div className="panel-body">
          {status.state === "not_configured" && (
            <p>
              Google is not set up on this server. Missing:{" "}
              {status.missing.map((name, i) => (
                <span key={name}>
                  {i > 0 ? ", " : ""}
                  <code>{name}</code>
                </span>
              ))}
              . Nothing is synced, and clients are told the connection is being set up.
            </p>
          )}
          {status.state === "not_connected" && (
            <>
              <p>The server is set up. Connect the agency&rsquo;s Google account — the one clients will add as a Manager.</p>
              <a className="button" href="/api/google/oauth/start">
                Connect Google account
              </a>
            </>
          )}
          {status.state === "needs_reconnect" && (
            <>
              <p>
                Google no longer accepts the sign-in for <strong>{status.email}</strong> (revoked, or expired — a Testing-mode
                consent screen expires it after 7 days). Syncing has stopped.
              </p>
              <a className="button" href="/api/google/oauth/start">
                Reconnect
              </a>
            </>
          )}
          {status.state === "no_access" && (
            <>
              <p>
                Signed in as <strong>{status.email}</strong>, but{" "}
                {status.reason === "quota"
                  ? "Google refuses every Business Profile call for quota: the project's API access has not been approved yet, so its quota is 0."
                  : "a Business Profile API is not enabled in the Google Cloud project."}
              </p>
              <p className="hint">
                {status.message ? <>Google said: &ldquo;{status.message}&rdquo; </> : null}
                {status.checkedAt ? <>Last checked {formatDateTime(status.checkedAt)}. </> : null}
                The portal checks again every six hours and switches on by itself once Google allows it.
              </p>
              <div className="gp-inline-actions">
                <ActionForm action={checkAccessAction} buttons={[{ label: "Check again now", value: "check", pendingLabel: "Checking…" }]} />
                <ActionForm action={disconnectAction} buttons={[{ label: "Disconnect", value: "disconnect", secondary: true, confirm: "Disconnect the agency's Google account?" }]} />
              </div>
            </>
          )}
          {status.state === "connected" && (
            <>
              <p>
                As <strong>{status.email}</strong>, since {formatDateWithYear(status.connectedAt)}.
                {status.lastSuccessAt ? <> Last answered {formatDateTime(status.lastSuccessAt)}.</> : null}
              </p>
              {status.pausedUntil && (
                <p className="notice notice-info">Google is limiting requests. Syncing and edits resume after {formatDateTime(status.pausedUntil)}.</p>
              )}
              {status.lastError && <p className="notice notice-danger">Last failure: {status.lastError}</p>}
              <ActionForm action={disconnectAction} buttons={[{ label: "Disconnect", value: "disconnect", secondary: true, confirm: "Disconnect the agency's Google account? Syncing stops until it is connected again." }]} />
            </>
          )}
        </div>
      </section>

      {status.state !== "connected" && (
        // Its own panel, open: until Google works this list is the page.
        <details className="panel panel-fold" open>
          <summary className="panel-head">
            <h2>Setup checklist</h2>
            <span className="panel-sub">What Google profile management needs, in order</span>
          </summary>
          <div className="panel-body">
            <SetupChecklist status={status} />
          </div>
        </details>
      )}
    </>
  );
}

function Queue({ queue }: { queue: Awaited<ReturnType<typeof getGoogleQueue>> }) {
  const empty =
    queue.unansweredReviews.length + queue.stalePosts.length + queue.gaps.length + queue.asks.length + queue.syncProblems.length === 0;

  return (
    <section className="panel" aria-labelledby="gp-queue">
      <div className="panel-head">
        <h2 id="gp-queue">To do</h2>
        <span className="panel-sub">Across every linked profile</span>
      </div>
      {empty ? (
        <div className="empty">
          <p>
            {queue.awaitingFirstSync.length > 0
              ? "Nothing to do yet. Linked profiles appear here after their first sync."
              : "Nothing waiting. Unanswered reviews, posts older than 30 days, profile gaps and client asks show up here."}
          </p>
        </div>
      ) : (
        <div className="panel-body">
          {queue.asks.length > 0 && (
            <QueueGroup title={`Client asks (${queue.asks.length})`}>
              {queue.asks.map((a) => (
                <li key={a.publicId}>
                  <span className="gp-queue-what">
                    <Link href={`/admin/google/${a.clientPublicId}#asks`}>{a.organizationName}</Link>
                    <p>{a.body}</p>
                  </span>
                  <span className="muted">{formatDateTime(a.createdAt)}</span>
                </li>
              ))}
            </QueueGroup>
          )}
          {queue.unansweredReviews.length > 0 && (
            <QueueGroup title={`Unanswered reviews (${queue.unansweredReviews.length})`}>
              {queue.unansweredReviews.map((r, i) => (
                <li key={`${r.clientPublicId}-${i}`}>
                  <span className="gp-queue-what">
                    <Link href={`/admin/google/${r.clientPublicId}#reviews`}>{r.organizationName}</Link> · <Stars rating={r.starRating} />{" "}
                    {r.reviewerName ?? "A Google user"}
                    {r.comment && <p>{r.comment.length > 160 ? `${r.comment.slice(0, 159)}…` : r.comment}</p>}
                  </span>
                  <span className="muted">
                    {formatDateWithYear(r.postedAt)}
                    {r.hasDraft ? " · draft ready" : ""}
                  </span>
                </li>
              ))}
            </QueueGroup>
          )}
          {queue.stalePosts.length > 0 && (
            <QueueGroup title={`No post in 30 days (${queue.stalePosts.length})`}>
              {queue.stalePosts.map((p) => (
                <li key={p.clientPublicId}>
                  <span className="gp-queue-what">
                    <Link href={`/admin/google/${p.clientPublicId}#post`}>{p.organizationName}</Link>
                  </span>
                  <span className="muted">{p.lastPostAt ? `Last post ${formatDateWithYear(p.lastPostAt)}` : "No posts yet"}</span>
                </li>
              ))}
            </QueueGroup>
          )}
          {queue.gaps.length > 0 && (
            <QueueGroup title={`Profile gaps (${queue.gaps.length})`}>
              {queue.gaps.map((g) => (
                <li key={g.clientPublicId}>
                  <span className="gp-queue-what">
                    <Link href={`/admin/google/${g.clientPublicId}`}>{g.organizationName}</Link>
                    <p>{g.items.map((item) => `${item.label}: ${item.detail}`).join(" · ")}</p>
                  </span>
                </li>
              ))}
            </QueueGroup>
          )}
          {queue.syncProblems.length > 0 && (
            <QueueGroup title={`Sync problems (${queue.syncProblems.length})`}>
              {queue.syncProblems.map((s) => (
                <li key={s.clientPublicId}>
                  <span className="gp-queue-what">
                    <Link href={`/admin/google/${s.clientPublicId}`}>{s.organizationName}</Link>
                    <p>{s.error}</p>
                  </span>
                  <span className="muted">{s.nextSyncAt ? `Retrying ${formatDateTime(s.nextSyncAt)}` : ""}</span>
                </li>
              ))}
            </QueueGroup>
          )}
        </div>
      )}
    </section>
  );
}

function QueueGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="gp-queue-group">
      <h3 className="panel-cell-title">{title}</h3>
      <ul className="gp-queue-list">{children}</ul>
    </div>
  );
}
