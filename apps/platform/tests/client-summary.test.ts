import { describe, expect, it } from "vitest";
import { plainSummary } from "@/lib/requests/summary";

/**
 * What a client reads under "What we changed".
 *
 * The owners reading this are not technical. They need one short paragraph
 * saying what was worked on and what is different now — not file names, not
 * notes meant for the agency, and not the tool's own sign-off.
 */

const MARKED = [
  "<!-- agent-job:01HXYZ -->",
  "<!-- client-summary -->",
  "We swapped the coin on your home page for the Chief in Waiting sculpture.",
  "The whole sculpture now shows, a little to the right so your title stays clear.",
  "<!-- /client-summary -->",
  "",
  "Files: index.html, styles.css",
  "",
  "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
].join("\n");

// PR #22 on ScottMortensenWebsite, written before the marker existed.
const LEGACY = [
  "The homepage hero now shows the Chief in Waiting sculpture instead of the coin.",
  "",
  "- The whole sculpture is visible (nothing cropped), sitting slightly right of centre so the title text on the left stays clear.",
  "- The image fades in from the left edge toward the right.",
  "- Brightened the photo a little (the old dark/sepia tint is gone) so it matches the warm theme.",
  "",
  "Files: `index.html`, `styles.css`, `script.js` (the scroll-zoom effect no longer assumes the old centred position).",
  "",
  "Notes:",
  "- The attached Indian.JPG is already in the repo as `Photos/web/Indian.jpg` (web-sized), so no new image was added.",
  "- Not previewed in a browser; worth a quick visual check on desktop and mobile.",
  "",
  "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
].join("\n");

describe("plainSummary", () => {
  it("takes only what the agent marked for the client, as one paragraph", () => {
    expect(plainSummary(MARKED)).toBe(
      "We swapped the coin on your home page for the Chief in Waiting sculpture. The whole sculpture now shows, a little to the right so your title stays clear.",
    );
  });

  it("turns an older write-up into one plain paragraph, without files, notes or sign-off", () => {
    const summary = plainSummary(LEGACY)!;

    expect(summary).toBe(
      "The homepage hero now shows the Chief in Waiting sculpture instead of the coin. " +
        "The whole sculpture is visible (nothing cropped), sitting slightly right of centre so the title text on the left stays clear. " +
        "The image fades in from the left edge toward the right. " +
        "Brightened the photo a little (the old dark/sepia tint is gone) so it matches the warm theme.",
    );
    expect(summary).not.toMatch(/Files|Notes|index\.html|Claude|🤖|`|\n/);
  });

  it("drops headings and stops at a technical section", () => {
    const body = [
      "<!-- agent-job:01HXYZ -->",
      "## What changed",
      "",
      'Replaced the hero photo with the one you named "new".',
      "",
      "### Files",
      "- src/index.html",
    ].join("\n");

    expect(plainSummary(body)).toBe('Replaced the hero photo with the one you named "new".');
  });

  it("is empty when there is nothing written for the client", () => {
    expect(plainSummary("<!-- agent-job:01HXYZ -->")).toBeNull();
    expect(plainSummary("🤖 Generated with [Claude Code](https://claude.com/claude-code)")).toBeNull();
    expect(plainSummary(null)).toBeNull();
  });

  it("leaves an already plain paragraph as it is", () => {
    const plain = "We updated your opening hours on the contact page and in the footer.";
    expect(plainSummary(plain)).toBe(plain);
    expect(plainSummary(plainSummary(LEGACY))).toBe(plainSummary(LEGACY));
  });

  it("keeps a long write-up to a readable length, ending on a sentence", () => {
    const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i + 1} about the change.`).join(" ");
    const summary = plainSummary(long)!;
    expect(summary.length).toBeLessThanOrEqual(600);
    expect(summary.endsWith(".")).toBe(true);
  });
});
