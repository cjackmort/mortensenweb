/**
 * The agent's account of a change, as a client reads it.
 *
 * The client is a business owner, usually on a phone, deciding whether to put
 * a change live. What they need is one short paragraph: what was worked on and
 * what is different now. A pull request description carries more than that —
 * file names, notes for the agency, the tool's own sign-off — and all of it
 * read as noise, or worse, as something they were expected to understand.
 *
 * The agent is asked to write that paragraph between `<!-- client-summary -->`
 * markers, and when it has, only the marked text is used. For a description
 * written before the markers existed, the paragraph is recovered: headings
 * dropped, list items read as sentences, and everything from the first
 * technical section or sign-off onward left out.
 *
 * Pure and idempotent, so it runs both when the summary is stored and when it
 * is shown — which is what tidies summaries saved before this existed.
 */

const MARKED = /<!--\s*client-summary\s*-->([\s\S]*?)<!--\s*\/client-summary\s*-->/i;

/** Where the part written for the agency begins. Nothing after it is shown. */
const TECHNICAL_LABEL =
  /^(?:\*\*|__)?(?:files?|changed files|notes?|testing|tests|technical(?: notes?)?|implementation|for the agency)(?:\*\*|__)?\s*:/i;
const TECHNICAL_HEADING =
  /^(?:files?|changed files|notes?|testing|tests|technical(?: notes?)?|implementation|for the agency)\b/i;
const SIGN_OFF = /generated with \[?claude|^🤖/i;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const HEADING = /^#{1,6}\s+(.*)$/;
const LIST_MARK = /^(?:[-*+]|\d+[.)])\s+/;
const ENDS_SENTENCE = /[.!?…:;]["'”’)\]]*$/;

/** Longest summary shown. A paragraph, not a report. */
const MAX_LENGTH = 600;

function stripInline(line: string): string {
  return line
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

function sentencesFrom(text: string): string[] {
  const sentences: string[] = [];

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (SIGN_OFF.test(line) || RULE.test(line) || TECHNICAL_LABEL.test(line)) break;

    const heading = HEADING.exec(line);
    if (heading) {
      if (TECHNICAL_HEADING.test(heading[1]!.trim())) break;
      continue;
    }

    const sentence = stripInline(line.replace(LIST_MARK, ""));
    if (!sentence) continue;
    sentences.push(ENDS_SENTENCE.test(sentence) ? sentence : `${sentence}.`);
  }

  return sentences;
}

function capped(paragraph: string): string {
  if (paragraph.length <= MAX_LENGTH) return paragraph;
  const head = paragraph.slice(0, MAX_LENGTH);
  const lastStop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  return lastStop > 0 ? head.slice(0, lastStop + 1) : `${head.slice(0, MAX_LENGTH - 1).trimEnd()}…`;
}

export function plainSummary(body: string | null | undefined): string | null {
  if (!body) return null;

  const normalised = body.replace(/\r\n?/g, "\n");
  const marked = MARKED.exec(normalised)?.[1];
  const text = (marked ?? normalised).replace(/<!--[\s\S]*?-->/g, "");

  const paragraph = sentencesFrom(text).join(" ").trim();
  return paragraph ? capped(paragraph) : null;
}
