import { formatDate, formatDateWithYear } from "@/lib/time";

/** Campaign dates are calendar days (`YYYY-MM-DD`), never instants. */

/** The days a campaign runs, from its two dates. */
export function durationDays(startsOn: string | null, endsOn: string | null): number | null {
  if (!startsOn || !endsOn) return null;
  const ms = Date.parse(`${endsOn}T00:00:00Z`) - Date.parse(`${startsOn}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

export function addDays(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** "Oct 25 – Nov 23, 2026". Noon UTC, so the business timezone keeps the same day. */
export function campaignDates(campaign: { startsOn: string | null; endsOn: string | null }): string | null {
  if (!campaign.startsOn || !campaign.endsOn) return null;
  const at = (day: string) => new Date(`${day}T12:00:00Z`);
  return `${formatDate(at(campaign.startsOn))} – ${formatDateWithYear(at(campaign.endsOn))}`;
}
