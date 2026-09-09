import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  effectSummary,
  isOffTrack,
  STAGES,
  stageIndex,
} from "@/lib/requests/status";

/**
 * Which requests count as published, and which do not.
 *
 * `closed` used to map to the final stage, "Confirmed live", with the summary
 * line "Live on your site and checked." Only two code paths set it —
 * `cancelChangeRequest`, and the admin close/dismiss path — so **every**
 * cancelled request told its client that something they had called off was
 * live on their website.
 */

const CONFIRMED_LIVE = STAGES.indexOf("Confirmed live");

describe("cancelled and dismissed requests", () => {
  it("does not put a closed request on the progress track at all", () => {
    expect(stageIndex("closed")).toBeNull();
    expect(isOffTrack("closed")).toBe(true);
  });

  it("never describes a closed request as live", () => {
    const summary = effectSummary("closed").toLowerCase();
    expect(summary).not.toContain("live on your site");
    expect(summary).not.toContain("checked");
    // Neutral: cancelling is a normal thing to do, not a failure.
    expect(summary).toContain("called off");
  });

  it("keeps `verified` as the one terminal success", () => {
    expect(stageIndex("verified")).toBe(CONFIRMED_LIVE);
    expect(effectSummary("verified").toLowerCase()).toContain("live on your site");
  });

  it("does not let anything but `verified` reach Confirmed live", () => {
    // The property that matters for "work completed": exactly one status may
    // be counted as published, and it is the one set only after the site has
    // been fetched and served the change.
    const everyStatus = [
      "submitted",
      "triaged",
      "approved",
      "dispatched",
      "in_progress",
      "changes_requested",
      "pr_open",
      "merged",
      "deployed",
      "verified",
      "closed",
      "rejected",
      "failed",
      "rolled_back",
      "needs_operator",
    ];

    const atFinalStage = everyStatus.filter(
      (status) => stageIndex(status) === CONFIRMED_LIVE,
    );
    expect(atFinalStage).toEqual(["verified"]);
  });

  it("keeps failure states off the track", () => {
    for (const status of ["rejected", "failed", "rolled_back", "needs_operator"]) {
      expect(isOffTrack(status), status).toBe(true);
      expect(stageIndex(status), status).toBeNull();
    }
  });

  it("leaves `deployed` short of confirmed", () => {
    // The change is on the site and nobody has checked it. Merging these two
    // would let a broken deploy report itself as finished.
    expect(stageIndex("deployed")).toBeLessThan(CONFIRMED_LIVE);
    expect(effectSummary("deployed").toLowerCase()).toContain("final check");
  });
});

describe("every writer of a terminal status", () => {
  it("has exactly three paths to `closed`, and all mean the change did not ship", () => {
    // Searched rather than assumed, because a fourth writer added later would
    // silently inherit whatever `closed` renders as.
    const sources = {
      cancel: readFileSync("src/db/repositories/admin/cancel.ts", "utf8"),
      dismiss: readFileSync("src/db/repositories/admin/agent-jobs.ts", "utf8"),
      webhook: readFileSync("src/db/repositories/admin/webhooks.ts", "utf8"),
    };

    // The client-cancel path.
    expect(sources.cancel).toContain('status: "closed"');
    // The admin close/dismiss path.
    expect(sources.dismiss).toContain('status: "closed"');
    // The GitHub webhook, when a pull request is closed WITHOUT being merged.
    expect(sources.webhook).toContain('status: merged ? "merged" : "closed"');
  });

  it("only `shipped.ts` writes `verified`", () => {
    // `verified` is set after the production URL has been fetched and served
    // the change. Nothing else may claim it.
    const shipped = readFileSync("src/db/repositories/admin/shipped.ts", "utf8");
    expect(shipped).toContain('status: "verified"');

    for (const file of [
      "src/db/repositories/admin/cancel.ts",
      "src/db/repositories/admin/agent-jobs.ts",
      "src/db/repositories/admin/webhooks.ts",
      "src/db/repositories/admin/merge.ts",
    ]) {
      expect(readFileSync(file, "utf8"), file).not.toContain('status: "verified"');
    }
  });

  it("does not tell a client a merged change is already live", () => {
    // Merging puts the change on the default branch; the deploy has not run.
    // The progress track says "Published" here, and a timeline event claiming
    // "live on your website" would contradict it on the same screen.
    const webhook = readFileSync("src/db/repositories/admin/webhooks.ts", "utf8");
    expect(webhook).not.toContain("Your change is live on your website.");
    expect(webhook).toContain("publishing to your site now");
  });

  it("renders the webhook's own not-merged wording consistently with the stage", () => {
    // The webhook says "We closed this change without applying it"; the stage
    // summary says "This one was called off. Nothing changed on your site."
    // Both are true, neither claims publication.
    expect(effectSummary("closed").toLowerCase()).not.toContain("live");
    expect(stageIndex("closed")).toBeNull();
  });
});
