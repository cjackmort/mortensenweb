import { describe, expect, it } from "vitest";
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
