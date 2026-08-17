"use client";

import { useActionState } from "react";
import {
  connectRepoAction,
  setAllowlistAction,
  type RepoActionResult,
} from "./repo-actions";

/**
 * Pointing the platform at a repository that already exists.
 *
 * For clients whose site predates the portal. Everything built through
 * scaffolding is connected already; this is the other half, and without it a
 * client on the books before Stage 3 could never receive automated work.
 */

export interface ConnectedRepo {
  owner: string;
  name: string;
  defaultBranch: string;
  allowlisted: boolean;
  previewUrlStyle: string;
  netlifySiteName: string | null;
}

export function RepositoryPanel({
  sitePublicId,
  siteName,
  connected,
}: {
  sitePublicId: string;
  siteName: string;
  connected: ConnectedRepo | null;
}) {
  const [connectState, connectAction, connecting] = useActionState<
    RepoActionResult | null,
    FormData
  >(connectRepoAction, null);
  const [allowState, allowAction, allowing] = useActionState<
    RepoActionResult | null,
    FormData
  >(setAllowlistAction, null);

  return (
    <section className="card">
      <div className="card-head">
        <h2>Repository</h2>
        <span className="muted">{siteName}</span>
      </div>

      {connected ? (
        <>
          <dl className="contact" style={{ marginBottom: "1rem" }}>
            <dt>Repository</dt>
            <dd>
              {connected.owner}/{connected.name}
            </dd>
            <dt>Branch</dt>
            <dd>{connected.defaultBranch}</dd>
            <dt>Netlify site</dt>
            <dd>{connected.netlifySiteName ?? "not set — previews cannot be shown"}</dd>
            <dt>Previews</dt>
            <dd>
              {connected.previewUrlStyle === "deploy_preview"
                ? "Netlify builds them from GitHub"
                : "The repository deploys its own"}
            </dd>
          </dl>

          {connected.allowlisted ? (
            <div className="notice notice-success" style={{ marginTop: 0 }}>
              <strong>Automated work is allowed here.</strong> Change requests
              for this site can be sent to the agent.
            </div>
          ) : (
            <div className="notice" style={{ marginTop: 0 }}>
              <strong>Automated work is switched off.</strong> The repository is
              connected, but nothing will write to it until you allow it.
            </div>
          )}

          {allowState && (
            <p className={allowState.ok ? "notice notice-success" : "error"}>
              {allowState.message}
            </p>
          )}

          <form action={allowAction} style={{ marginTop: "1rem" }}>
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
                  ? "Switch automated work off"
                  : "Allow automated work"}
            </button>
          </form>

          {/* Reversible, and said so plainly. An operator who becomes uneasy
              needs to know that stopping is available and cheap, or they will
              hesitate over allowing it in the first place. */}
          <p className="field-hint">
            You can switch this off at any time. Doing so stops new work being
            sent; anything already in flight finishes and still needs the
            client&rsquo;s approval before it goes live.
          </p>

          {/* Connecting used to be one-way: the form disappeared once a
              repository was attached, so a mistyped Netlify site name or the
              wrong preview convention could not be corrected — and both fail
              silently, which is exactly when someone needs to change them.
              `connectExistingRepo` has always updated an existing row; only
              the UI was one-way. */}
          <details style={{ marginTop: "1.25rem" }}>
            <summary style={{ cursor: "pointer" }}>Change these settings</summary>
            <div style={{ marginTop: "1rem" }}>
              {connectState && (
                <p className={connectState.ok ? "notice notice-success" : "error"}>
                  {connectState.message}
                </p>
              )}
            <form action={connectAction}>
              <input type="hidden" name="sitePublicId" value={sitePublicId} />

              <label htmlFor="repo">Repository</label>
              <input
                id="repo"
                name="repo"
                placeholder="cjackmort/ScottMortensenWebsite"
                defaultValue={connected ? `${connected.owner}/${connected.name}` : ""}
                required
              />
              <p className="field-hint">
                Owner and name, or paste the GitHub URL. The App must be able to
                see it.
              </p>

              <label htmlFor="netlifySiteName">Netlify site name</label>
              <input
                id="netlifySiteName"
                name="netlifySiteName"
                placeholder="scott-mortensen-fine-arts"
                defaultValue={connected?.netlifySiteName ?? ""}
              />
              {/* Without this there is no preview URL to build, and the failure
                  is silent: the agent works, the pull request opens, Netlify
                  builds a preview, and the client is shown nothing. */}
              <p className="field-hint">
                The name in Netlify, not the full address &mdash; the part before
                <code>.netlify.app</code>. Previews cannot be shown to the client
                without it.
              </p>

              <label htmlFor="previewUrlStyle">How previews are built</label>
              <select
                id="previewUrlStyle"
                name="previewUrlStyle"
                defaultValue={connected?.previewUrlStyle ?? "deploy_preview"}
              >
                <option value="deploy_preview">
                  Netlify builds them from GitHub (existing site)
                </option>
                <option value="pr_alias">
                  The repository deploys its own (built from our template)
                </option>
              </select>
              {/* This choice decides a URL the portal later fetches. Getting it
                  wrong is silent: the link 404s, the preview is never shown, and
                  the request sits on "being worked on" until the watchdog fails
                  it — with nothing pointing at the naming convention. */}
              <p className="field-hint">
                A site already connected to Netlify through GitHub uses the first.
                Getting this wrong means previews never appear, so check if
                you&rsquo;re unsure.
              </p>

              <button type="submit" disabled={connecting}>
                {connecting ? "Saving…" : connected ? "Update settings" : "Connect repository"}
              </button>
            </form>
            </div>
          </details>

        </>
      ) : (
        <>
          <p style={{ marginTop: 0 }}>
            This site has no repository connected, so change requests cannot be
            worked on. Point it at one you already have.
          </p>

          {connectState && (
            <p className={connectState.ok ? "notice notice-success" : "error"}>
              {connectState.message}
            </p>
          )}

          <form action={connectAction}>
            <input type="hidden" name="sitePublicId" value={sitePublicId} />

            <label htmlFor="repo">Repository</label>
            <input
              id="repo"
              name="repo"
              placeholder="cjackmort/ScottMortensenWebsite"
              required
            />
            <p className="field-hint">
              Owner and name, or paste the GitHub URL. The App must be able to
              see it.
            </p>

            <label htmlFor="netlifySiteName">Netlify site name</label>
            <input
              id="netlifySiteName"
              name="netlifySiteName"
              placeholder="scott-mortensen-fine-arts"
            />
            {/* Without this there is no preview URL to build, and the failure
                is silent: the agent works, the pull request opens, Netlify
                builds a preview, and the client is shown nothing. */}
            <p className="field-hint">
              The name in Netlify, not the full address &mdash; the part before
              <code>.netlify.app</code>. Previews cannot be shown to the client
              without it.
            </p>

            <label htmlFor="previewUrlStyle">How previews are built</label>
            <select
              id="previewUrlStyle"
              name="previewUrlStyle"
              defaultValue="deploy_preview"
            >
              <option value="deploy_preview">
                Netlify builds them from GitHub (existing site)
              </option>
              <option value="pr_alias">
                The repository deploys its own (built from our template)
              </option>
            </select>
            {/* This choice decides a URL the portal later fetches. Getting it
                wrong is silent: the link 404s, the preview is never shown, and
                the request sits on "being worked on" until the watchdog fails
                it — with nothing pointing at the naming convention. */}
            <p className="field-hint">
              A site already connected to Netlify through GitHub uses the first.
              Getting this wrong means previews never appear, so check if
              you&rsquo;re unsure.
            </p>

            <button type="submit" disabled={connecting}>
              {connecting ? "Connecting…" : "Connect repository"}
            </button>
          </form>
        </>
      )}
    </section>
  );
}
