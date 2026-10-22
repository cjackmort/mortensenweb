import { describe, expect, it } from "vitest";
import { ALL_STATUSES } from "@/lib/requests/status";
import { googleOutput, siteOutput } from "@/lib/showcase/status";

/**
 * What each output says to the client. The site page is the one that can
 * mislead: "Live" for a change that has not reached the site, or "Preview
 * ready" for one the operator has not released, would send a client to look
 * for something that is not there.
 */

describe("siteOutput", () => {
  it("is not sent while the write-up is a draft", () => {
    expect(siteOutput({ approved: false, blockedReason: null, request: null }).state).toBe("not_sent");
  });

  it("is waiting, with the reason, when the page could not be sent", () => {
    const out = siteOutput({ approved: true, blockedReason: "one_at_a_time", request: null });
    expect(out.state).toBe("blocked");
    expect(out.label).toBe("Waiting");
    expect(out.detail).toMatch(/another change/i);
    expect(out.canSend).toBe(true);
  });

  it("says preview ready only once the operator has released it", () => {
    expect(
      siteOutput({ approved: true, blockedReason: null, request: { status: "pr_open", previewReleased: false } }).state,
    ).toBe("waiting");
    expect(
      siteOutput({ approved: true, blockedReason: null, request: { status: "pr_open", previewReleased: true } }).state,
    ).toBe("preview_ready");
  });

  it("says live only once the change is deployed", () => {
    expect(
      siteOutput({ approved: true, blockedReason: null, request: { status: "merged", previewReleased: true } }).state,
    ).toBe("waiting");
    for (const status of ["deployed", "verified"]) {
      expect(
        siteOutput({ approved: true, blockedReason: null, request: { status, previewReleased: true } }).label,
      ).toBe("Live");
    }
  });

  it("offers to send again only when the change was stopped", () => {
    for (const status of ALL_STATUSES) {
      const out = siteOutput({ approved: true, blockedReason: null, request: { status, previewReleased: false } });
      const stopped = ["closed", "rejected", "rolled_back"].includes(status);
      expect(out.canSend, status).toBe(stopped);
      expect(out.state === "stopped", status).toBe(stopped);
    }
  });

  it("has a label for every request status", () => {
    for (const status of ALL_STATUSES) {
      const out = siteOutput({ approved: true, blockedReason: null, request: { status, previewReleased: true } });
      expect(["Waiting", "Preview ready", "Live", "Not published"]).toContain(out.label);
    }
  });
});

describe("googleOutput", () => {
  it("is nothing before approval", () => {
    expect(googleOutput(null).state).toBe("none");
  });

  it("asks for a manual post until a connection exists", () => {
    const out = googleOutput("manual");
    expect(out.label).toBe("Post manually");
  });

  it("says posted, and says a failure plainly", () => {
    expect(googleOutput("posted").label).toBe("Posted");
    expect(googleOutput("failed").label).toBe("Didn't post");
  });
});
