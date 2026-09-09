import { describe, expect, it } from "vitest";
import { mediaFailureMessage } from "@/lib/media/errors";

/**
 * Who is allowed to see why a media operation failed.
 *
 * Two audiences with opposite needs. A client should never be shown an
 * exception — it tells them nothing they can act on and may say more about the
 * system than it should. An operator needs exactly that, because the
 * alternative is what happened in production: every upload failing, the only
 * real detail in a function log, and the person who had to fix it reading a
 * sentence that named no cause.
 *
 * The split is on the session's role, so it cannot be asked for.
 */

const boom = new TypeError("store.set is not a function");

describe("what a failed media operation says", () => {
  it("tells a client the step, and nothing about the exception", () => {
    const message = mediaFailureMessage("save that part", boom, "client");

    expect(message).toMatch(/could not save that part/i);
    expect(message).toMatch(/problem on our side/i);
    expect(message).not.toContain("store.set");
    expect(message).not.toContain("TypeError");
    expect(message).not.toContain("[operator]");
  });

  it("gives an operator the underlying error", () => {
    const message = mediaFailureMessage("save that part", boom, "admin");

    expect(message).toMatch(/could not save that part/i);
    expect(message).toContain("[operator]");
    expect(message).toContain("TypeError");
    expect(message).toContain("store.set is not a function");
  });

  it("keeps the client's half of the operator message identical", () => {
    const asClient = mediaFailureMessage("save that part", boom, "client");
    const asAdmin = mediaFailureMessage("save that part", boom, "admin");

    // The operator sees the same sentence a client would, plus detail — not a
    // different explanation, which is how two people end up describing one
    // failure incompatibly.
    expect(asAdmin.startsWith(asClient)).toBe(true);
  });

  it("survives something thrown that is not an Error", () => {
    const message = mediaFailureMessage("save that part", "just a string", "admin");

    expect(message).toContain("just a string");
  });

  it("truncates rather than pasting a whole stack into the page", () => {
    const huge = new Error("x".repeat(5000));

    const message = mediaFailureMessage("save that part", huge, "admin");

    expect(message.length).toBeLessThan(700);
  });

  it("names the step it was given, so the two routes stay distinguishable", () => {
    expect(mediaFailureMessage("finish saving that image", boom, "client")).toMatch(
      /finish saving that image/i,
    );
  });
});
