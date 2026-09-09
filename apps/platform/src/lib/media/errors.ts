/**
 * What a media failure is allowed to say, and to whom.
 *
 * A client gets the step that failed and nothing else — an exception in front
 * of someone paying for a website is noise at best and a leak at worst.
 *
 * An operator gets the underlying message, because the alternative is what
 * actually happened here: every upload failing in production, the only real
 * detail sitting in a function log, and the person who needed it reading a
 * sentence that told them nothing. Diagnosing your own product should not
 * require finding the Netlify console.
 *
 * `role` comes from the session, never from the request, so a client cannot ask
 * for the operator version.
 */

/** Trimmed hard: a stack in a JSON field helps nobody read it in a browser. */
const MAX_DETAIL = 300;

export function mediaFailureMessage(
  step: string,
  error: unknown,
  role: "admin" | "client",
): string {
  const base =
    `We could not ${step}. This is a problem on our side, not your ` +
    `connection — please try again, and tell us if it keeps happening.`;

  if (role !== "admin") return base;

  const detail =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  return `${base}

[operator] ${detail.slice(0, MAX_DETAIL)}`;
}
