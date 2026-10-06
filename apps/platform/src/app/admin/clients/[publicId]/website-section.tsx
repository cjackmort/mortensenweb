import type { listSitesWithAnalytics } from "@/db/repositories/admin/sites";
import { InternalPanel } from "./internal-forms";
import { LaunchPanel } from "./launch-forms";
import { RepositoryPanel } from "./repo-forms";
import { AddSiteForm, PreviewModeForm } from "./site-forms";

export type SiteRow = Awaited<ReturnType<typeof listSitesWithAnalytics>>[number];

/** Each site's code, hosting and launch, then whether this is the agency's own. */
export function WebsiteSection({
  clientPublicId,
  organizationName,
  sites,
  isInternal,
}: {
  clientPublicId: string;
  organizationName: string;
  sites: SiteRow[];
  isInternal: boolean;
}) {
  return (
    <>
      {sites.length === 0 && (
        <section className="card">
          <div className="card-head">
            <h2>No site yet</h2>
          </div>
          <p className="muted" style={{ marginTop: 0 }}>
            Add their site to connect a repository, hosting and analytics.
          </p>
          <AddSiteForm clientPublicId={clientPublicId} suggestedName={organizationName} />
        </section>
      )}

      {sites.map((site) => (
        <div key={site.publicId}>
          <section className="card">
            <div className="card-head">
              <h2>{site.name}</h2>
              <span className="muted">{site.primaryDomain ?? "no domain yet"}</span>
            </div>
            <dl className="detail-grid" style={{ marginBottom: 0 }}>
              <dt>Status</dt>
              <dd>{site.status}</dd>
              <dt>Repository</dt>
              <dd>{site.repoOwner ? `${site.repoOwner}/${site.repoName}` : "not connected"}</dd>
              <dt>Hosting</dt>
              <dd>{site.netlifySiteName ?? "not set up"}</dd>
            </dl>
          </section>

          <RepositoryPanel
            sitePublicId={site.publicId}
            siteName={site.name}
            connected={
              site.repoOwner && site.repoName
                ? {
                    owner: site.repoOwner,
                    name: site.repoName,
                    defaultBranch: site.repoDefaultBranch ?? "main",
                    allowlisted: site.automationEnabled ?? false,
                    previewUrlStyle: site.previewUrlStyle ?? "pr_alias",
                    netlifySiteName: site.netlifySiteName ?? null,
                  }
                : null
            }
          />

          <section className="card">
            <div className="card-head">
              <h2>Launch</h2>
            </div>
            <LaunchPanel
              sitePublicId={site.publicId}
              clientPublicId={clientPublicId}
              domain={site.primaryDomain}
              status={site.status}
              dnsSentAt={site.dnsInstructionsSentAt}
              liveVerifiedAt={site.liveVerifiedAt}
              automationEnabled={site.automationEnabled ?? false}
              hasRepository={Boolean(site.repoOwner)}
            />
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Picture on the Clients page</h2>
            </div>
            <PreviewModeForm
              clientPublicId={clientPublicId}
              sitePublicId={site.publicId}
              currentMode={site.previewMode ?? "screenshot"}
            />
          </section>
        </div>
      ))}

      <InternalPanel clientPublicId={clientPublicId} isInternal={isInternal} />
    </>
  );
}
