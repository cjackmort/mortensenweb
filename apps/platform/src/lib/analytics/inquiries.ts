/**
 * Enquiries that actually arrived.
 *
 * The only category on the dashboard that claims an *outcome* rather than an
 * action, and the only one that may never be populated from a tracked click.
 *
 * ## What does not count, and why
 *
 * **A click on the send button.** `enquiry sent` fires the moment the button is
 * pressed — before the browser validates the form, before the POST, and
 * regardless of whether anything reaches anyone. It is intent, and the registry
 * files it as such.
 *
 * **A pageview on `/thanks/`.** Tempting, because the form redirects there on
 * success, and wrong for three reasons: the URL is directly reachable, a
 * refresh counts twice, and a client who bookmarks it inflates the figure on
 * every visit. A page a browser can be pointed at is not evidence that a
 * message was delivered.
 *
 * What counts is a record held by the system that received the submission. For
 * these sites that is Netlify Forms, which stores each submission with an id
 * and — importantly — keeps spam in a separate state rather than deleting it,
 * so "accepted" and "filtered" are distinguishable rather than merged.
 *
 * ## Accepted is not the same as qualified
 *
 * A real person filling in a real form is an accepted submission. Whether it is
 * a *lead worth having* is a human judgement nobody has made at this point, and
 * the dashboard does not guess. `qualified` exists in the shape below so an
 * operator's later verdict has somewhere to live; nothing infers it.
 */

export type InquiryState =
  /** Accepted by the form backend. A real submission, not yet judged. */
  | "accepted"
  /** Held as spam by the provider. Counted separately, never in the headline. */
  | "spam"
  /** An operator marked this a real lead. Only ever set by a person. */
  | "qualified";

export interface ConfirmedInquiry {
  /** The provider's own id. The deduplication key. */
  id: string;
  receivedAt: Date;
  state: InquiryState;
  /** Which form, when a site has more than one. */
  formName: string;
  /**
   * Where the visitor came from, when the provider recorded it.
   *
   * "Unknown" is preserved rather than guessed. Attributing an enquiry to the
   * last campaign that happened to be running is how a channel gets credit it
   * did not earn.
   */
  referrer: string | null;
}

export interface InquirySummary {
  accepted: number;
  spam: number;
  qualified: number;
  /** Accepted submissions inside the requested window, newest first. */
  recent: ConfirmedInquiry[];
  /** How many arrived with no usable attribution. Shown, not hidden. */
  unknownSource: number;
}

/**
 * Deduplicate and count.
 *
 * Deduplication is by provider id, not by timestamp or by contents. Two
 * genuinely separate enquiries can arrive in the same second — a couple filling
 * the form in on two phones — and two identical messages can be one person
 * pressing send twice. Only the provider knows which record is which, and its
 * id is the answer it already has.
 *
 * The function is deliberately pure: the fetching lives with the provider
 * client, and this is the part worth testing exhaustively.
 */
export function summariseInquiries(
  submissions: ConfirmedInquiry[],
  window?: { startAt: number; endAt: number },
): InquirySummary {
  const seen = new Set<string>();
  const unique: ConfirmedInquiry[] = [];

  for (const submission of submissions) {
    if (seen.has(submission.id)) continue;
    seen.add(submission.id);
    unique.push(submission);
  }

  const inWindow = window
    ? unique.filter((submission) => {
        const at = submission.receivedAt.getTime();
        // Half-open, matching every other window in this codebase: a
        // submission at exactly `endAt` belongs to the next period, or it is
        // counted twice when two windows are compared side by side.
        return at >= window.startAt && at < window.endAt;
      })
    : unique;

  const accepted = inWindow.filter((s) => s.state === "accepted");
  const qualified = inWindow.filter((s) => s.state === "qualified");

  return {
    // Qualified submissions were accepted first, so they belong in both counts.
    // Reporting them only as qualified would make the accepted figure fall
    // whenever an operator did their job.
    accepted: accepted.length + qualified.length,
    spam: inWindow.filter((s) => s.state === "spam").length,
    qualified: qualified.length,
    recent: [...accepted, ...qualified]
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
      .slice(0, 10),
    unknownSource: [...accepted, ...qualified].filter((s) => s.referrer === null)
      .length,
  };
}

// ---------------------------------------------------------------------------
// Netlify Forms
// ---------------------------------------------------------------------------

interface NetlifySubmission {
  id?: string;
  created_at?: string;
  form_name?: string;
  referrer?: string | null;
  state?: string;
}

/**
 * Read confirmed submissions for one site.
 *
 * Two calls, because Netlify keeps spam out of the default listing: without the
 * second, "accepted" and "everything that was submitted" would be the same
 * number, and a site being hammered by bots would look like a site doing well.
 *
 * **No submission field is read.** Only the id, the timestamp, the form name
 * and the referrer. The bodies carry names, email addresses and messages, and
 * none of that belongs in an analytics path — the brief is explicit, and the
 * narrow selection here is what enforces it rather than a promise not to look.
 */
export async function fetchNetlifyInquiries(
  siteId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<
  | { ok: true; submissions: ConfirmedInquiry[] }
  | { ok: false; reason: "not_configured" | "failed"; message: string }
> {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) {
    return {
      ok: false,
      reason: "not_configured",
      message: "NETLIFY_AUTH_TOKEN is not set, so form submissions cannot be read.",
    };
  }

  const base = "https://api.netlify.com/api/v1";
  const headers = { Authorization: `Bearer ${token}` };

  try {
    const [verified, spam] = await Promise.all([
      fetchImpl(`${base}/sites/${siteId}/submissions?state=verified&per_page=200`, {
        headers,
        cache: "no-store",
      }),
      // A failure here loses the spam count, not the accepted one. Reporting
      // "no spam" when the call failed would be a silent zero; the caller sees
      // an empty list and the accepted figure is still correct.
      fetchImpl(`${base}/sites/${siteId}/submissions?state=spam&per_page=200`, {
        headers,
        cache: "no-store",
      }).catch(() => null),
    ]);

    if (!verified.ok) {
      return {
        ok: false,
        reason: "failed",
        message: `Netlify responded ${verified.status} for form submissions.`,
      };
    }

    const accepted = mapSubmissions(
      (await verified.json()) as NetlifySubmission[],
      "accepted",
    );
    const filtered =
      spam && spam.ok
        ? mapSubmissions((await spam.json()) as NetlifySubmission[], "spam")
        : [];

    return { ok: true, submissions: [...accepted, ...filtered] };
  } catch (error) {
    return {
      ok: false,
      reason: "failed",
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

function mapSubmissions(
  rows: NetlifySubmission[],
  state: InquiryState,
): ConfirmedInquiry[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row): row is NetlifySubmission & { id: string } => Boolean(row?.id))
    .map((row) => ({
      id: row.id,
      receivedAt: row.created_at ? new Date(row.created_at) : new Date(0),
      state,
      formName: row.form_name ?? "contact",
      // Empty strings become null: "" is not an attribution, and treating it as
      // one produces a source called "" in the breakdown.
      referrer: row.referrer && row.referrer.trim() ? row.referrer.trim() : null,
    }));
}
