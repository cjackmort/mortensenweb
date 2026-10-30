/**
 * Whether the agency is ahead or behind, in the words the operator uses:
 * "in the green" or "in the red". Read from a profit figure — income less
 * fees less expenses — so it is a judgement of the ledger, not of the bank.
 *
 * Exactly zero is its own answer. Calling it green would cheer a month in
 * which nothing happened; calling it red would alarm about one.
 */

export type StandingTone = "green" | "red" | "even";

export interface Standing {
  tone: StandingTone;
  label: string;
}

export function standingOf(profitCents: number): Standing {
  if (profitCents > 0) return { tone: "green", label: "In the green" };
  if (profitCents < 0) return { tone: "red", label: "In the red" };
  return { tone: "even", label: "Breaking even" };
}
