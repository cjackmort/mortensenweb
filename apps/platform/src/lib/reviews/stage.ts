import { formatDate } from "@/lib/time";

/**
 * One review request as the list shows it: a status pill for a glance, and
 * the three facts a client asks about — when it went, whether the customer
 * opened the link, and what happened to the reminder.
 *
 * A request that did not go out never reads as sent. "Not sent" is red when
 * the provider refused it, amber when sending simply is not switched on here.
 */

export type Tone = "neutral" | "success" | "info" | "warning" | "danger";

export interface RequestFacts {
  emailStatus: string | null;
  smsStatus: string | null;
  sentAt: Date | null;
  clickedAt: Date | null;
  reminderDueAt: Date | null;
  remindedAt: Date | null;
  reminderStatus: string | null;
  unsubscribedAt: Date | null;
}

export interface RequestDescription {
  pill: { label: string; tone: Tone };
  sent: string;
  opened: string;
  reminder: string;
}

const REMINDER_NOT_SENT: Record<string, string> = {
  sending: "Sending",
  suppressed: "Not sent: they opted out",
  failed: "Could not be sent",
  not_sent: "Not sent",
};

function channels(row: RequestFacts): string {
  const email = row.emailStatus === "sent";
  const text = row.smsStatus === "sent";
  return email && text ? "email and text" : text ? "text" : "email";
}

function notSent(row: RequestFacts): { label: string; tone: Tone } {
  const statuses = [row.emailStatus, row.smsStatus];
  if (statuses.includes("failed")) return { label: "Could not be sent", tone: "danger" };
  if (statuses.includes("suppressed")) return { label: "They opted out", tone: "neutral" };
  return { label: "Sending is not switched on", tone: "warning" };
}

export function describeRequest(row: RequestFacts): RequestDescription {
  if (!row.sentAt) {
    const why = notSent(row);
    return { pill: { label: "Not sent", tone: why.tone }, sent: why.label, opened: "—", reminder: "—" };
  }

  const sent = `${formatDate(row.sentAt)} · ${channels(row)}`;
  const opened = row.clickedAt ? formatDate(row.clickedAt) : "Not yet";
  const reminder =
    row.reminderStatus === "sent" && row.remindedAt
      ? `Sent ${formatDate(row.remindedAt)}`
      : row.reminderStatus
        ? (REMINDER_NOT_SENT[row.reminderStatus] ?? "Not sent")
        : row.clickedAt
          ? "Not needed"
          : row.reminderDueAt
            ? `Due ${formatDate(row.reminderDueAt)}`
            : "Off";

  const pill: RequestDescription["pill"] = row.unsubscribedAt
    ? { label: "Unsubscribed", tone: "neutral" }
    : row.clickedAt
      ? { label: "Clicked", tone: "success" }
      : row.reminderStatus === "sent"
        ? { label: "Reminded", tone: "info" }
        : { label: "Sent", tone: "neutral" };

  return { pill, sent, opened, reminder };
}
