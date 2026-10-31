import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSiteGitLink,
  gitLinkOf,
  NetlifyApiError,
  NetlifyConfigError,
} from "@/lib/netlify/api";

/**
 * Whether Netlify builds a site from a GitHub repository.
 *
 * The portal creates sites unlinked and deploys them from a workflow in the
 * repository. A site that was already live is usually linked, so Netlify builds
 * every push itself — and installing our deploy workflow there would publish
 * every change twice. `build_settings.repo_url` is how Netlify says which.
 */

describe("gitLinkOf", () => {
  it("is linked when Netlify names the repository", () => {
    expect(
      gitLinkOf({
        build_settings: {
          repo_url: "https://github.com/cjackmort/site-hair-by-graci",
          repo_path: "cjackmort/site-hair-by-graci",
          repo_branch: "main",
        },
      }),
    ).toEqual({
      status: "linked",
      repoUrl: "https://github.com/cjackmort/site-hair-by-graci",
      repoPath: "cjackmort/site-hair-by-graci",
      branch: "main",
    });
  });

  it("is linked on the repository path alone", () => {
    expect(gitLinkOf({ build_settings: { repo_path: "cjackmort/site-acme" } })).toMatchObject({
      status: "linked",
      repoUrl: null,
      repoPath: "cjackmort/site-acme",
    });
  });

  it.each([
    ["no build settings", {}],
    ["empty build settings", { build_settings: {} }],
    ["null fields", { build_settings: { repo_url: null, repo_path: null, repo_branch: null } }],
    ["blank strings", { build_settings: { repo_url: "  ", repo_path: "" } }],
  ])("is unlinked with %s", (_label, site) => {
    expect(gitLinkOf(site)).toEqual({ status: "unlinked" });
  });
});

describe("getSiteGitLink", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    process.env.NETLIFY_AUTH_TOKEN = "test-token";
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NETLIFY_AUTH_TOKEN;
  });

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("reads the site by id and reports its linked repository", async () => {
    fetchMock.mockResolvedValue(
      json(200, {
        id: "nf-1",
        name: "hair-by-graci",
        build_settings: { repo_url: "https://github.com/cjackmort/site-hair-by-graci", repo_branch: "main" },
      }),
    );

    expect(await getSiteGitLink("nf-1")).toMatchObject({
      status: "linked",
      repoUrl: "https://github.com/cjackmort/site-hair-by-graci",
    });
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://api.netlify.com/api/v1/sites/nf-1");
  });

  it("reports a site with no repository as unlinked", async () => {
    fetchMock.mockResolvedValue(json(200, { id: "nf-2", name: "concept-acme", build_settings: {} }));
    expect(await getSiteGitLink("nf-2")).toEqual({ status: "unlinked" });
  });

  it("accepts a default subdomain where an id is expected", async () => {
    fetchMock.mockResolvedValue(json(200, { id: "nf-3", name: "acme" }));
    await getSiteGitLink("acme.netlify.app");
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://api.netlify.com/api/v1/sites/acme.netlify.app");
  });

  it("says not_found for a site Netlify does not have, rather than unlinked", async () => {
    fetchMock.mockResolvedValue(json(404, { message: "Not Found" }));
    expect(await getSiteGitLink("gone")).toEqual({ status: "not_found" });
  });

  it("throws when Netlify fails, so the caller cannot mistake an outage for 'not linked'", async () => {
    fetchMock.mockResolvedValue(json(503, { message: "Service Unavailable" }));
    await expect(getSiteGitLink("nf-1")).rejects.toBeInstanceOf(NetlifyApiError);
  });

  it("throws when there is no token", async () => {
    delete process.env.NETLIFY_AUTH_TOKEN;
    await expect(getSiteGitLink("nf-1")).rejects.toBeInstanceOf(NetlifyConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
