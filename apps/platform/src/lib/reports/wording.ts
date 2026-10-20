import { formatDate } from "@/lib/time";
import type { ContactEvent, MissingReason, MonthlyReportData } from "./types";

/**
 * Every sentence the report says, in one place, so the page, the email and the
 * admin preview cannot describe the same figure three ways.
 *
 * Written from the visitor's side, like the event registry: a tap on a phone
 * number opens a dialler, and nothing here may call it a phone call.
 */

/** Why a section is empty, as a full sentence for the report page. */
export const MISSING_MESSAGES: Record<MissingReason, string> = {
  analytics_not_configured:
    "Analytics isn't connected yet, so there are no visitor figures for this month.",
  analytics_not_connected:
    "Analytics isn't set up on your site yet, so visits weren't recorded this month.",
  analytics_error:
    "We couldn't reach the analytics service when this report was made. That's our problem, not a drop in your traffic.",
  no_site: "You don't have a website with us yet.",
  forms_not_connected:
    "Your contact form isn't connected to your portal yet, so enquiries aren't counted here.",
  not_tracked: "Your site doesn't record taps on your phone number or email address yet.",
  failed: "This part of the report couldn't be produced.",
};

/** The same, as a phrase for the headline and the email. */
const MISSING_SHORT: Record<MissingReason, string> = {
  analytics_not_configured: "analytics not connected yet",
  analytics_not_connected: "analytics not connected yet",
  analytics_error: "figures unavailable",
  no_site: "no website yet",
  forms_not_connected: "contact form not connected yet",
  not_tracked: "not tracked on your site yet",
  failed: "couldn't be produced",
};

export const CONTACT_LABELS: Record<ContactEvent, { label: string; one: string; many: string }> = {
  phone_tapped: { label: "Taps on your phone number", one: "tap on your phone number", many: "taps on your phone number" },
  email_tapped: { label: "Taps on your email address", one: "tap on your email address", many: "taps on your email address" },
  booking_opened: { label: "Opened your booking link", one: "booking link opened", many: "booking links opened" },
};

export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * "up 18%", "down 5%", "about the same", or null when there is nothing to
 * compare against. A missing comparison is no phrase at all: "0% change" and
 * "no comparison" mean different things.
 */
export function trend(change: number | null): string | null {
  if (change === null || !Number.isFinite(change)) return null;
  const percent = Math.round(Math.abs(change) * 100);
  if (percent === 0) return "about the same";
  return `${change > 0 ? "up" : "down"} ${percent.toLocaleString("en-US")}%`;
}

const HEADLINE_PARTS = 3;

/**
 * The one line a client reads first: "312 visitors, up 18%; 7 enquiries".
 *
 * Visitors lead even when they are missing, stated as missing, because the
 * headline is where a client would otherwise assume a quiet month.
 */
export function headline(data: MonthlyReportData): string {
  const parts: string[] = [];

  if (data.visitors.state === "ok") {
    const change = trend(data.visitors.change);
    parts.push(`${plural(data.visitors.visitors, "visitor", "visitors")}${change ? `, ${change}` : ""}`);
  } else {
    parts.push(`visitors: ${MISSING_SHORT[data.visitors.reason]}`);
  }

  if (data.enquiries?.state === "ok") {
    parts.push(plural(data.enquiries.received, "enquiry", "enquiries"));
  }

  if (data.contact.state === "ok") {
    const phone = data.contact.rows.find((row) => row.id === "phone_tapped");
    if (phone && phone.count > 0) parts.push(plural(phone.count, "tap to call", "taps to call"));
  }

  if (data.changes.items.length > 0) {
    parts.push(plural(data.changes.items.length, "change made", "changes made"));
  }

  for (const extra of data.extras) {
    if (extra.state === "ok" && extra.headline) parts.push(extra.headline);
  }

  return capitalise(parts.slice(0, HEADLINE_PARTS).join("; "));
}

export interface GlanceLine {
  key: string;
  title: string;
  text: string;
  missing: boolean;
}

function visitorsLine(data: MonthlyReportData): GlanceLine {
  const section = data.visitors;
  if (section.state === "missing") {
    return { key: "visitors", title: "Visitors", text: capitalise(MISSING_SHORT[section.reason]), missing: true };
  }
  const change = trend(section.change);
  const comparison = change
    ? change === "about the same"
      ? `, about the same as ${data.previousMonthName}`
      : `, ${change} on ${data.previousMonthName}`
    : "";
  return { key: "visitors", title: "Visitors", text: `${section.visitors.toLocaleString("en-US")}${comparison}`, missing: false };
}

function contactLine(data: MonthlyReportData): GlanceLine {
  const section = data.contact;
  if (section.state === "missing") {
    return { key: "contact", title: "People reaching out", text: capitalise(MISSING_SHORT[section.reason]), missing: true };
  }
  const text = section.rows
    .map((row) => plural(row.count, CONTACT_LABELS[row.id].one, CONTACT_LABELS[row.id].many))
    .join(", ");
  return { key: "contact", title: "People reaching out", text: capitalise(text), missing: false };
}

function enquiriesLine(data: MonthlyReportData): GlanceLine | null {
  const section = data.enquiries;
  if (!section) return null;
  if (section.state === "missing") {
    return { key: "enquiries", title: "Enquiries", text: capitalise(MISSING_SHORT[section.reason]), missing: true };
  }
  const before = section.previous === null ? "" : ` (${section.previous.toLocaleString("en-US")} in ${data.previousMonthName})`;
  return { key: "enquiries", title: "Enquiries", text: `${section.received.toLocaleString("en-US")}${before}`, missing: false };
}

function healthLine(data: MonthlyReportData): GlanceLine {
  const section = data.health;
  if (section.state === "missing") {
    return { key: "health", title: "Your website", text: capitalise(MISSING_SHORT[section.reason]), missing: true };
  }
  return { key: "health", title: "Your website", text: healthSentence(section), missing: false };
}

/** "Online, last checked Oct 1." */
export function healthSentence(section: Extract<MonthlyReportData["health"], { state: "ok" }>): string {
  if (!section.live) return "Not live yet";
  if (!section.lastConfirmedAt) return "Live, not yet checked by us";
  const when = formatDate(section.lastConfirmedAt);
  return section.stale ? `Last confirmed online on ${when}` : `Online, last checked ${when}`;
}

/** One line per section, in report order: the email body and the report's summary list. */
export function glance(data: MonthlyReportData): GlanceLine[] {
  const changes = data.changes.items.length;
  const lines: (GlanceLine | null)[] = [
    visitorsLine(data),
    contactLine(data),
    enquiriesLine(data),
    {
      key: "changes",
      title: "Changes made",
      text: changes === 0 ? "None this month" : changes.toLocaleString("en-US"),
      missing: false,
    },
    healthLine(data),
    ...data.extras.map((extra) => ({
      key: extra.key,
      title: extra.title,
      text: extra.headline ?? extra.note ?? (extra.state === "missing" ? "Not available" : "Nothing this month"),
      missing: extra.state === "missing",
    })),
  ];
  return lines.filter((line): line is GlanceLine => line !== null);
}
