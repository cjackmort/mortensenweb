/**
 * Drafting a showcase's wording from the client's few words.
 *
 * No model writes this. The portal never calls one, and a model is exactly
 * what would add "fully licensed" or "in under a day" to a sentence that said
 * neither. The draft is assembled from three things only: what the job was,
 * the town, and anything else the client typed, plus the phone number or
 * booking link from General information for the closing line. A test feeds in
 * a profile full of claims (year founded, licence number, awards) and checks
 * that none of them appear.
 *
 * It is a draft: the client reads it, edits it and approves it before
 * anything is published.
 */

export interface ShowcaseWords {
  job: string;
  town: string;
  notes: string | null;
}

/** The General information fields a draft may use. Nothing else is read. */
export interface DraftProfile {
  phone?: string;
  bookingUrl?: string;
  [other: string]: string | undefined;
}

export interface Wording {
  title: string;
  writeUp: string;
  caption: string;
}

export const LIMITS = {
  job: 160,
  town: 60,
  notes: 600,
  title: 120,
  writeUp: 3000,
  caption: 1000,
} as const;

/** Longest caption that still sits in two or three lines on a 1080px graphic. */
const GRAPHIC_CAPTION_MAX = 80;

/**
 * Words that end in "ed" and are not past-tense verbs. A short list is
 * enough: anything it misses reads slightly oddly in a draft the client is
 * about to read anyway, and a job description rarely starts with one.
 */
const NOT_VERBS = new Set(["shed", "bed", "red", "seed", "need", "feed", "speed", "breed", "weed", "hundred"]);

/** Past tenses that do not end in "ed", among the jobs a trade does. */
const IRREGULAR_PAST = new Set([
  "built", "rebuilt", "made", "remade", "put", "laid", "relaid", "set", "reset",
  "cut", "dug", "fit", "hung", "rehung", "ran", "did", "redid", "gave", "took",
  "brought", "swept", "wrote", "drew", "sold", "sewed", "sewn", "grew", "threw",
  "spun", "wove", "bound", "won", "shot", "dealt", "knit",
]);

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function withoutEndPunctuation(value: string): string {
  return value.replace(/[\s.!,;:]+$/, "");
}

function upperFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** "Replaced" → "replaced", but "HVAC" and "LED" stay as written. */
function lowerFirstWord(value: string): string {
  const [first = "", ...rest] = value.split(" ");
  const isAcronym = first.length > 1 && first === first.toUpperCase();
  const word = isAcronym ? first : first.charAt(0).toLowerCase() + first.slice(1);
  return [word, ...rest].join(" ");
}

function asSentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? upperFirst(trimmed) : `${upperFirst(trimmed)}.`;
}

function startsWithPastTense(job: string): boolean {
  const first = job.split(" ")[0]?.toLowerCase().replace(/[^a-z-]/g, "") ?? "";
  if (IRREGULAR_PAST.has(first)) return true;
  return first.length > 4 && first.endsWith("ed") && !first.endsWith("eed") && !NOT_VERBS.has(first);
}

function mentionsTown(job: string, town: string): boolean {
  return job.toLowerCase().includes(town.toLowerCase());
}

function closingLine(profile: DraftProfile): string | null {
  const phone = profile.phone?.trim();
  if (phone) return `Need something similar? Call ${phone}.`;
  const booking = profile.bookingUrl?.trim();
  if (booking) return `Need something similar? Book at ${booking}.`;
  return null;
}

function firstSentence(text: string): string {
  const match = text.match(/^.*?[.!?](\s|$)/);
  return (match ? match[0] : text).trim();
}

export function draftShowcase(input: {
  job: string;
  town: string;
  notes?: string | null;
  profile: DraftProfile;
}): Wording {
  const job = withoutEndPunctuation(collapse(input.job));
  const town = withoutEndPunctuation(collapse(input.town));
  const where = mentionsTown(job, town) ? "" : ` in ${town}`;

  const title = upperFirst(`${job}${where}`);
  const lead = startsWithPastTense(job)
    ? `We ${lowerFirstWord(job)}${where}.`
    : `${upperFirst(job)}${where}.`;
  const notes = input.notes ? asSentence(collapse(input.notes)) : "";
  const closing = closingLine(input.profile);

  const opening = [lead, notes].filter(Boolean).join(" ");
  const writeUp = [opening, closing].filter(Boolean).join("\n\n");
  const caption = [lead, notes ? firstSentence(notes) : "", closing].filter(Boolean).join(" ");

  return { title, writeUp, caption };
}

export type WordsCheck = { ok: true; words: ShowcaseWords } | { ok: false; message: string };

/** The client's few words, as typed on the form. */
export function validateShowcaseWords(input: {
  job: unknown;
  town: unknown;
  notes?: unknown;
}): WordsCheck {
  const job = withoutEndPunctuation(collapse(String(input.job ?? "")));
  const town = withoutEndPunctuation(collapse(String(input.town ?? "")));
  const notes = collapse(String(input.notes ?? ""));

  if (job.length < 3) return { ok: false, message: "Say what the job was, in a few words." };
  if (job.length > LIMITS.job) {
    return { ok: false, message: `Keep the job to ${LIMITS.job} characters. There's room for more below.` };
  }
  if (town.length < 2) return { ok: false, message: "Say which town the job was in." };
  if (town.length > LIMITS.town) return { ok: false, message: "That town name is too long." };
  if (notes.length > LIMITS.notes) {
    return { ok: false, message: `Keep the extra detail under ${LIMITS.notes} characters.` };
  }

  return { ok: true, words: { job, town, notes: notes || null } };
}

export type WordingCheck = { ok: true; wording: Wording } | { ok: false; message: string };

/** The client's edits to the draft, before approval. */
export function validateWording(input: { title: unknown; writeUp: unknown; caption: unknown }): WordingCheck {
  const title = collapse(String(input.title ?? ""));
  // Paragraph breaks are the client's and stay; anything else is tidied.
  const writeUp = String(input.writeUp ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const caption = String(input.caption ?? "").replace(/\r\n?/g, "\n").trim();

  if (title.length < 3) return { ok: false, message: "Give it a title." };
  if (title.length > LIMITS.title) return { ok: false, message: `Keep the title under ${LIMITS.title} characters.` };
  if (writeUp.length < 10) return { ok: false, message: "Write a sentence or two about the job." };
  if (writeUp.length > LIMITS.writeUp) {
    return { ok: false, message: `Keep the write-up under ${LIMITS.writeUp} characters.` };
  }
  if (caption.length < 3) return { ok: false, message: "Add a caption for social posts." };
  if (caption.length > LIMITS.caption) {
    return { ok: false, message: `Keep the caption under ${LIMITS.caption} characters.` };
  }

  return { ok: true, wording: { title, writeUp, caption } };
}

/** The text on the graphic itself: the title, shortened at a word if it must be. */
export function graphicCaption(title: string): string {
  const flat = collapse(title);
  if (flat.length <= GRAPHIC_CAPTION_MAX) return flat;
  const cut = flat.slice(0, GRAPHIC_CAPTION_MAX - 1);
  const atWord = cut.slice(0, cut.lastIndexOf(" ")).replace(/[\s,;:.-]+$/, "");
  return `${atWord}…`;
}
