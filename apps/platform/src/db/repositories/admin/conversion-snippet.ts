import { isUmamiConfigured, trackingScriptUrl, trackingSnippet } from "@/lib/analytics/umami";
import {
  findOpenPullRequest,
  getBranchHead,
  getFileContent,
  openPullRequest,
  putFileContent,
  setBranch,
} from "@/lib/github/rest";
import { connectSiteJson, type PortalIdentifiers } from "@/lib/site-json/connect";
import { parseSiteJson, SITE_JSON_PATH } from "@/lib/site-json/read";
import type { ConversionSite, SiteJsonLoad } from "./conversion-state";
import type { StepOutcome } from "./conversion-steps";

/**
 * Putting the analytics id and the portal site id into the site, by pull
 * request.
 *
 * A pull request rather than a commit to the default branch, unlike the
 * workflow callers: this changes what the site publishes, and on a scaffolded
 * repository the default branch *is* the live preview. The pull request also
 * gets its own preview from the deploy workflow, and it is where the
 * `new-client` skill lifts the demo rules (noindex, the banner) before
 * merging.
 *
 * Reported as `manual` until merged, because until then the site still sends
 * nothing to Umami. Re-running finds the same pull request rather than
 * opening another, and brings its `site.json` up to date if an id changed —
 * on top of whatever else has been committed to the branch.
 */

export const CONNECT_BRANCH = "portal/connect-site";

export async function connectSiteToPortal(
  site: ConversionSite & { repo: NonNullable<ConversionSite["repo"]> },
  umamiWebsiteId: string,
  json: SiteJsonLoad,
  businessName: string,
): Promise<StepOutcome> {
  if (!json.ok) {
    if (json.reason === "absent") {
      return {
        status: "manual",
        detail: `${json.message} Put this in every page's <head>: ${trackingSnippet(umamiWebsiteId)}`,
      };
    }
    return { status: json.reason === "invalid" ? "failed" : "skipped", detail: json.message };
  }

  const ids: PortalIdentifiers = {
    umamiWebsiteId,
    umamiScriptUrl: isUmamiConfigured() ? trackingScriptUrl() : null,
    sitePublicId: site.sitePublicId,
  };
  const onDefault = connectSiteJson(json.source, json.raw, ids);
  const originNote = onDefault.scriptOriginMismatch
    ? " Its pages load Umami from Cloud, but the portal's Umami is self-hosted: the site needs a template with analytics.umamiScriptUrl before visits are counted."
    : "";

  if (onDefault.changed.length === 0) {
    return {
      status: originNote ? "failed" : "ok",
      detail: `site.json already has the Umami website and the portal site id.${originNote}`,
    };
  }

  const { target, defaultBranch, repository } = site.repo;
  const open = await findOpenPullRequest(target, CONNECT_BRANCH);

  if (open) {
    // The branch may carry other work by now (the demo rules being lifted),
    // so its own copy is updated rather than replaced from the default branch.
    const onBranch = await getFileContent(target, SITE_JSON_PATH, CONNECT_BRANCH);
    const parsed = onBranch ? parseSiteJson(onBranch.content) : null;
    if (onBranch && parsed?.ok) {
      const update = connectSiteJson(onBranch.content, parsed.raw, ids);
      if (update.changed.length > 0) {
        await putFileContent(target, SITE_JSON_PATH, {
          content: update.text,
          message: `chore: portal ids in site.json (${update.changed.join(", ")})`,
          branch: CONNECT_BRANCH,
          sha: onBranch.sha,
        });
      }
    }
    return {
      status: "manual",
      detail: `Merge ${open.html_url} to put the analytics id and portal site id on the site.${originNote}`,
    };
  }

  const head = await getBranchHead(target, defaultBranch);
  if (!head) return { status: "failed", detail: `${repository} has no ${defaultBranch} branch.` };

  await setBranch(target, CONNECT_BRANCH, head);
  await putFileContent(target, SITE_JSON_PATH, {
    content: onDefault.text,
    message: `chore: connect the site to the portal (${onDefault.changed.join(", ")})`,
    branch: CONNECT_BRANCH,
    sha: json.sha,
  });

  const pr = await openPullRequest(target, {
    title: "Connect the site to the portal",
    head: CONNECT_BRANCH,
    base: defaultBranch,
    body: [
      `Opened by the Mortensen Web Co. portal when ${businessName} became a client.`,
      "",
      `Sets in \`${SITE_JSON_PATH}\`:`,
      ...onDefault.changed.map((path) => `- \`${path}\``),
      "",
      "Until this is merged the site reports no visits to the portal's dashboard,",
      "and its booking and shop pages (if any) ask the portal about the wrong site.",
    ].join("\n"),
  });

  return {
    status: "manual",
    detail: `Opened ${pr.html_url} (${repository}). Merge it to put the analytics id and portal site id on the site.${originNote}`,
  };
}
