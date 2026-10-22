/**
 * The change request that puts a showcase on the client's site.
 *
 * It travels the ordinary pipeline: a GitHub issue in the client's repository,
 * worked by the agent, previewed, approved, merged. The photos are attached
 * as library assets, so dispatch hands the agent signed links to the
 * originals exactly as it does for any request with images.
 *
 * The brief says twice that the wording is approved and final, because the
 * agent's instinct on a "project page" is to write marketing copy around it,
 * and the client has already said what they want said.
 */

export type PhotoRole = "photo" | "before" | "after";

const REQUEST_TITLE_MAX = 120;

function pairLine(photos: Array<{ role: PhotoRole }>): string | null {
  const before = photos.findIndex((p) => p.role === "before");
  const after = photos.findIndex((p) => p.role === "after");
  if (before < 0 || after < 0) return null;
  return `Photo ${before + 1} is before and photo ${after + 1} is after: show them as a before-and-after pair.`;
}

export function siteRequestBrief(
  showcase: { title: string; writeUp: string; town: string },
  photos: Array<{ role: PhotoRole }>,
): { title: string; description: string } {
  const prefix = "Add a project: ";
  const room = REQUEST_TITLE_MAX - prefix.length;
  const name = showcase.title.length > room ? `${showcase.title.slice(0, room - 1).trimEnd()}…` : showcase.title;

  const count = photos.length === 1 ? "1 photo" : `${photos.length} photos`;
  const lines = [
    "Please add this finished job to the site as a project page. If the site already has a projects, gallery or our-work section, add it there as a new entry and link it from that section.",
    "",
    "Use the title and write-up below exactly as written — the client has approved them. Do not add details that are not here: no dates, prices, guarantees, licences or claims about the business.",
    "",
    `Title: ${showcase.title}`,
    `Town: ${showcase.town}`,
    "",
    "Write-up:",
    showcase.writeUp,
    "",
    `Photos: ${count}, attached in the order to show them.`,
    pairLine(photos),
    "Use descriptive alt text from the title and town.",
  ].filter((line): line is string => line !== null);

  return { title: `${prefix}${name}`, description: lines.join("\n") };
}
