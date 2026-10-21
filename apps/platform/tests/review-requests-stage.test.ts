import { describe, expect, it } from "vitest";
import { describeRequest } from "@/lib/reviews/stage";

/**
 * What each row of the request list says. The dangerous mistake is a request
 * that never went out reading as "Sent", so a client believes a customer was
 * asked when they were not.
 */

const base = {
  emailStatus: "sent" as string | null,
  smsStatus: null as string | null,
  sentAt: new Date("2026-10-17T18:00:00Z") as Date | null,
  clickedAt: null as Date | null,
  reminderDueAt: new Date("2026-10-20T18:00:00Z") as Date | null,
  remindedAt: null as Date | null,
  reminderStatus: null as string | null,
  unsubscribedAt: null as Date | null,
};

describe("describeRequest", () => {
  it("shows a sent email with its reminder still to come", () => {
    expect(describeRequest(base)).toEqual({
      pill: { label: "Sent", tone: "neutral" },
      sent: "Oct 17 · email",
      opened: "Not yet",
      reminder: "Due Oct 20",
    });
  });

  it("shows a click, and that no reminder is needed", () => {
    const row = { ...base, clickedAt: new Date("2026-10-18T02:00:00Z") };
    expect(describeRequest(row)).toMatchObject({
      pill: { label: "Clicked", tone: "success" },
      opened: "Oct 17",
      reminder: "Not needed",
    });
  });

  it("shows a reminder that went", () => {
    const row = { ...base, remindedAt: new Date("2026-10-20T18:00:00Z"), reminderStatus: "sent" };
    expect(describeRequest(row)).toMatchObject({ pill: { label: "Reminded", tone: "info" }, reminder: "Sent Oct 20" });
  });

  it("says why a reminder did not go", () => {
    const at = new Date("2026-10-20T18:00:00Z");
    expect(describeRequest({ ...base, remindedAt: at, reminderStatus: "suppressed" }).reminder).toBe("Not sent: they opted out");
    expect(describeRequest({ ...base, remindedAt: at, reminderStatus: "failed" }).reminder).toBe("Could not be sent");
    expect(describeRequest({ ...base, reminderDueAt: null }).reminder).toBe("Off");
  });

  it("never calls a failed request sent", () => {
    const row = { ...base, emailStatus: "failed", sentAt: null, reminderDueAt: null };
    expect(describeRequest(row)).toEqual({
      pill: { label: "Not sent", tone: "danger" },
      sent: "Could not be sent",
      opened: "—",
      reminder: "—",
    });
  });

  it("says plainly when sending is switched off on this server", () => {
    const row = { ...base, emailStatus: "not_sent", sentAt: null, reminderDueAt: null };
    expect(describeRequest(row).pill).toEqual({ label: "Not sent", tone: "warning" });
    expect(describeRequest(row).sent).toBe("Sending is not switched on");
  });

  it("names both channels when it went by email and text", () => {
    expect(describeRequest({ ...base, smsStatus: "sent" }).sent).toBe("Oct 17 · email and text");
    expect(describeRequest({ ...base, emailStatus: null, smsStatus: "sent" }).sent).toBe("Oct 17 · text");
  });

  it("shows an unsubscribe above everything else", () => {
    const row = { ...base, clickedAt: new Date("2026-10-18T02:00:00Z"), unsubscribedAt: new Date("2026-10-18T03:00:00Z") };
    expect(describeRequest(row).pill).toEqual({ label: "Unsubscribed", tone: "neutral" });
  });
});
