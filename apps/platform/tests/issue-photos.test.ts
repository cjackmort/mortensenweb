import { describe, expect, it } from "vitest";
import { renderIssueBody } from "@/lib/github/issue";

/**
 * What the agent is told about images, and when.
 *
 * The rule the media library has to honour: **selecting images changes the
 * instructions, selecting none changes nothing.** A client who writes "use the
 * chief in waiting photo" without picking anything must produce exactly the
 * issue the portal produced before the library existed — the agent then works
 * from what is committed to the repository, as it always did.
 *
 * This matters because the two states give the agent contradictory-sounding
 * advice on purpose. With photos attached it is told to download from a URL;
 * without them, downloading from anywhere is forbidden. Emitting the attached
 * section when nothing is attached would point the agent at a list that is not
 * there; omitting it when something is would have it refuse a photo the client
 * had just given it.
 */

const base = {
  requestPublicId: "REQ123",
  agentJobPublicId: "JOB456",
  title: "New hero image",
  description: "Use the chief in waiting photo on the front page.",
  category: "content",
  priority: "normal",
};

const PHOTO_HEADING = "### Photos the client attached";

describe("the images section of a change-request issue", () => {
  it("says nothing about attached photos when the client selected none", () => {
    const body = renderIssueBody({ ...base });

    expect(body).not.toContain(PHOTO_HEADING);
    // Nor any stray download instruction that would send the agent hunting.
    expect(body).not.toMatch(/\[download\]/);
  });

  it("is unchanged by an empty selection, not merely nearly unchanged", () => {
    // `[]` and `undefined` reach this from different call sites — a request
    // with the media library open but nothing ticked, versus one raised before
    // the library existed. They must produce the same issue.
    //
    // Compared with the fence nonce masked. The client's words are wrapped in
    // a delimiter carrying fresh randomness on every render, so that quoted
    // text cannot close the fence and address the agent directly. That makes
    // two renders never byte-identical, and it is the one difference that is
    // supposed to be there.
    const mask = (body: string) => body.replace(/CLIENT-TEXT-[A-Z0-9]+/g, "NONCE");

    expect(mask(renderIssueBody({ ...base, attachmentUrls: [] }))).toBe(
      mask(renderIssueBody({ ...base })),
    );
  });

  it("gives the quoted client text a fresh fence nonce each time", () => {
    // Guards the masking above from hiding a real regression: if the nonce
    // ever became constant, the mask would still pass while the injection
    // guard it exists for had quietly stopped working.
    const first = renderIssueBody({ ...base });
    const second = renderIssueBody({ ...base });

    const nonceOf = (body: string) =>
      body.match(/CLIENT-TEXT-([A-Z0-9]+)/)?.[1] ?? null;

    expect(nonceOf(first)).not.toBeNull();
    expect(nonceOf(first)).not.toBe(nonceOf(second));
  });

  it("still carries the client's words when no photo is attached", () => {
    const body = renderIssueBody({ ...base });

    // The whole point of the no-selection path: the request itself is intact,
    // so the agent works from the description against the repository.
    expect(body).toContain("Use the chief in waiting photo");
    expect(body).toContain("REQ123");
  });

  it("lists the photos, with links, once the client selects some", () => {
    const body = renderIssueBody({
      ...base,
      attachmentUrls: [
        {
          url: "https://portal.example.test/api/media/agent/tok1",
          title: "Chief in waiting",
          caption: "the one on the easel",
          width: 4032,
          height: 3024,
          folderPath: "/Western",
        },
      ],
    });

    expect(body).toContain(PHOTO_HEADING);
    expect(body).toContain("Chief in waiting");
    expect(body).toContain("https://portal.example.test/api/media/agent/tok1");
    // Dimensions and folder are what let the agent judge whether a photo can
    // carry a hero, and where the client thinks it belongs.
    expect(body).toContain("4032x3024");
    expect(body).toContain("/Western");
    expect(body).toContain("the one on the easel");
  });

  it("tells the agent to commit the file rather than link the URL", () => {
    const body = renderIssueBody({
      ...base,
      attachmentUrls: [
        { url: "https://portal.example.test/api/media/agent/tok1", title: "A", caption: null },
      ],
    });

    // A page left pointing at the signed URL loses its image when the token
    // expires, silently, some time after the client approved it.
    expect(body).toMatch(/Download each one into the repository/i);
    expect(body).toMatch(/expires/i);
  });

  it("keeps the job marker in both states, or the portal loses the request", () => {
    const without = renderIssueBody({ ...base });
    const with_ = renderIssueBody({
      ...base,
      attachmentUrls: [
        { url: "https://portal.example.test/api/media/agent/tok1", title: "A", caption: null },
      ],
    });

    for (const body of [without, with_]) {
      expect(body).toContain("agent-job:");
      expect(body).toContain("JOB456");
    }
  });
});
