import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { createGithubFake } from "./helpers/github-fake";

/**
 * The deploy caller the portal writes into a scaffolded repository on
 * conversion. It must be the template's file exactly, so a site converted from
 * a concept deploys the same way as one scaffolded today.
 */

const github: { fake: ReturnType<typeof createGithubFake> | null } = { fake: null };

vi.mock("@/lib/github/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/github/app")>();
  const { createGithubFake } = await import("./helpers/github-fake");
  github.fake = createGithubFake(actual.GithubApiError);
  return {
    ...actual,
    githubRequest: (...args: Parameters<typeof actual.githubRequest>) =>
      github.fake!.request(...(args as [string, string, never])),
  };
});

const { DEPLOY_CALLER_WORKFLOW, DEPLOY_WORKFLOW_PATH, installDeployCaller } = await import(
  "@/lib/github/deploy-workflow"
);

const repo = { installationId: "1", owner: "cjackmort", name: "site-acme" };

beforeEach(() => github.fake!.reset());

describe("the deploy caller", () => {
  it("is the template file, character for character", () => {
    const template = readFileSync(
      resolve(process.cwd(), "../../templates/client-repo/.github/workflows/deploy.yml"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    expect(DEPLOY_CALLER_WORKFLOW).toBe(template);
  });

  it("installs, replaces an older copy, and writes nothing when current", async () => {
    expect(await installDeployCaller(repo, "main")).toBe("installed");
    expect(github.fake!.file("cjackmort/site-acme", "main", DEPLOY_WORKFLOW_PATH)).toBe(DEPLOY_CALLER_WORKFLOW);

    github.fake!.seedFile("cjackmort/site-acme", "main", DEPLOY_WORKFLOW_PATH, "name: a full old copy\n");
    expect(await installDeployCaller(repo, "main")).toBe("replaced");

    const writes = github.fake!.writes().length;
    expect(await installDeployCaller(repo, "main")).toBe("current");
    expect(github.fake!.writes()).toHaveLength(writes);
  });

  it("commits with [skip ci], since nothing a visitor sees changes", async () => {
    await installDeployCaller(repo, "main");
    const put = github.fake!.writes()[0]!;
    expect(String(put.body!.message)).toContain("[skip ci]");
  });
});
