"use client";

import { useActionState } from "react";
import {
  connectRepoAction,
  setAllowlistAction,
  type RepoActionResult,
} from "./repo-actions";
import { connectAnalyticsAction, type SiteActionResult } from "./site-actions";

/**
 * Everything that makes a site workable, in one place.
 *
 * This was three things stacked inside one another — an analytics field, a
 * repository box nested in the site card, a launch section below — each with
 * its own heading and its own notice, two of which said the same thing in
 * different words. The operator's actual question is singular: *is this site
 * ready to be worked on?* It should be answerable by looking once.
 *
 * The order is the order things happen: point at the code, confirm where it
 * deploys, connect analytics, then allow the agent to work.
 */

export interface ConnectedRepo {
  owner: string;
  name: string;
  defaultBranch: string;
  allowlisted: boolean;
  previewUrlStyle: string;
  netlifySiteName: string | null;
}

function Row({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={warn ? "error" : undefined} style={{ margin: 0 }}>
        {value}
      </dd>
    </>
  );
}

const RULE = {
  margin: "1.75rem 0",
  border: 0,
  borderTop: "1px solid var(--line)",
} as const;

export function RepositoryPanel({
  sitePublicId,
  clientPublicId,
  siteName,
  connected,
  umamiWebsiteId,
}: {
  sitePublicId: string;
  clientPublicId: string;
  siteName: string;
  connected: ConnectedRepo | null;
  umamiWebsiteId: string | null;
}) {
  const [connectState, connectAction, connecting] = useActionState<
    RepoActionResult | null,
    FormData
  >(connectRepoAction, null);
  const [allowState, allowAction, allowing] = useActionState<
    RepoActionResult | null,
    FormData
  >(setAllowlistAction, null);
  const [umamiState, umamiAction, savingUmami] = useActionState<
    SiteActionResult | null,
    FormData
  >(connectAnalyticsAction, null);

  const previewsReady = Boolean(connected?.netlifySiteName);

  return (
    <section className="card">
      <div className="card-head">
        <h2>Site setup</h2>
        <span className="muted">{siteName}</span>
      </div>

      {/* ---- 1. The code -------------------------------------------------- */}
      {connected ? (
        <>
          <dl className="contact" style={{ marginBottom: "1rem" }}>
            <Row
              label="Repository"
              value={`${connected.owner}/${connected.name}`}
            />
            <Row label="Branch" value={connected.defaultBranch} />
            <Row
              label="Netlify site"
              value={
                connected.netlifySiteName ??
                "not found — previews cannot be shown"
              }
              warn={!connected.netlifySiteName}
            />
            <Row
              label="Previews"
              value={
                connected.previewUrlStyle === "deploy_preview"
                  ? "Netlify builds them from GitHub"
                  : "the repository publishes its own"
              }
            />
          </dl>

          {!previewsReady && (
            // Said once, plainly, where it matters — rather than left to be
            // discovered half an hour later when the watchdog fails the
            // request with no explanation attached.
            <p className="notice">
              <strong>Previews will not reach the client.</strong> Without a
              Netlify site the portal cannot build a preview address: the agent
              will work and open a pull request, and the client will be shown
              nothing.
            </p>
          )}
        </>
      ) : (
        <p style={{ marginTop: 0 }}>
          No repository connected, so change requests cannot be worked on.
        </p>
      )}

      {connectState && (
        <p className={connectState.ok ? "notice notice-success" : "error"}>
          {connectState.message}
        </p>
      )}

      <details open={!connected} style={{ marginTop: connected ? "1rem" : 0 }}>
        <summary style={{ cursor: "pointer" }}>
          {connected ? "Change the repository" : "Connect a repository"}
        </summary>

        <form action={connectAction} style={{ marginTop: "1rem" }}>
          <input type="hidden" name="sitePublicId" value={sitePublicId} />

          <label htmlFor="repo">Repository</label>
          <input
            id="repo"
            name="repo"
            placeholder="cjackmort/ScottMortensenWebsite"
            defaultValue={
              connected ? `${connected.owner}/${connected.name}` : ""
            }
            required
          />
          <p className="field-hint">
            Owner and name, or paste the GitHub URL. The Netlify site and how
            previews are addressed are found automatically — fill the two below
            in only if that comes back empty.
          </p>

          <label htmlFor="netlifySiteName">Netlify site name</label>
          <input
            id="netlifySiteName"
            name="netlifySiteName"
            placeholder="found automatically"
            defaultValue={connected?.netlifySiteName ?? ""}
          />

          <label htmlFor="previewUrlStyle">How previews are built</label>
          <select
            id="previewUrlStyle"
            name="previewUrlStyle"
            defaultValue={connected?.previewUrlStyle ?? ""}
          >
            <option value="">Work it out automatically</option>
            <option value="deploy_preview">
              Netlify builds them from GitHub
            </option>
            <option value="pr_alias">The repository publishes its own</option>
          </select>

          <button type="submit" disabled={connecting}>
            {connecting ? "Saving…" : connected ? "Save" : "Connect"}
          </button>
        </form>
      </details>

      {/* ---- 2. Analytics ------------------------------------------------- */}
      <hr style={RULE} />

      <h3 style={{ fontSize: "0.95rem", marginTop: 0 }}>Analytics</h3>

      {umamiState &&
        (umamiState.ok ? (
          <p className="notice notice-success">Analytics connection saved.</p>
        ) : (
          <p className="error">{umamiState.message}</p>
        ))}

      <form action={umamiAction}>
        <input type="hidden" name="clientPublicId" value={clientPublicId} />
        <input type="hidden" name="sitePublicId" value={sitePublicId} />

        <label htmlFor="umamiWebsiteId">Umami website ID</label>
        <input
          id="umamiWebsiteId"
          name="umamiWebsiteId"
          defaultValue={umamiWebsiteId ?? ""}
          placeholder="4f5eaf4e-5e3e-4545-b742-d2fb05e1a911"
        />
        <p className="field-hint">
          Umami &rarr; Websites &rarr; the site &rarr; Edit. The{" "}
          <code>data-website-id</code> from the tracking snippet, not the API
          key. Leave blank to disconnect.
        </p>

        <button type="submit" className="secondary" disabled={savingUmami}>
          {savingUmami ? "Saving…" : "Save analytics"}
        </button>
      </form>

      {/* ---- 3. Permission ------------------------------------------------ */}
      {connected && (
        <>
          <hr style={RULE} />

          <h3 style={{ fontSize: "0.95rem", marginTop: 0 }}>Automated work</h3>

          {/* One statement of the current state, not two. This used to show a
              standing notice and the action's result side by side, which read
              as two different facts about the same setting. */}
          {allowState ? (
            <p className={allowState.ok ? "notice notice-success" : "error"}>
              {allowState.message}
            </p>
          ) : connected.allowlisted ? (
            <p className="notice notice-success">
              <strong>Allowed.</strong> Change requests for this site can be
              sent to the agent.
            </p>
          ) : (
            <p className="notice">
              <strong>Not allowed yet.</strong> The repository is connected, but
              nothing will write to it until you turn this on.
            </p>
          )}

          <form action={allowAction}>
            <input type="hidden" name="sitePublicId" value={sitePublicId} />
            <input
              type="hidden"
              name="allowlisted"
              value={connected.allowlisted ? "false" : "true"}
            />
            <button
              type="submit"
              className={connected.allowlisted ? "secondary" : undefined}
              disabled={allowing}
            >
              {allowing
                ? "Saving…"
                : connected.allowlisted
                  ? "Turn off"
                  : "Allow automated work"}
            </button>
          </form>

          <p className="field-hint">
            Reversible at any time. Turning it off stops new work being sent;
            anything already in flight finishes and still needs the
            client&rsquo;s approval before it goes live.
          </p>
        </>
      )}
    </section>
  );
}
