/**
 * Text messages, through Twilio, and only when the operator has set it up.
 *
 * Off unless `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and a sender
 * (`TWILIO_MESSAGING_SERVICE_SID`, or `TWILIO_FROM_NUMBER`) are all set. Off,
 * the dashboard does not offer texting at all, rather than offering it and
 * failing — and nothing here ever falls back to a default sender.
 *
 * Consent is not checked here; it is checked before this is called, and held
 * by a constraint on `review_requests` (see `sendReviewRequest`).
 *
 * STOP: Twilio handles opt-out keywords on its side and refuses later sends to
 * that number with error 21610. That refusal is reported as `opted_out`, and
 * the caller adds the number to the business's suppression list, so the
 * portal stops trying instead of failing on every reminder.
 */

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

export type SmsResult =
  | { status: "sent"; id: string }
  | { status: "skipped" }
  | { status: "opted_out" }
  | { status: "failed"; error: string };

/** Twilio: "Attempt to send to unsubscribed recipient". */
const TWILIO_OPTED_OUT = 21610;
const TIMEOUT_MS = 10_000;

export function smsConfigured(env: Env = process.env): boolean {
  return Boolean(
    env.TWILIO_ACCOUNT_SID?.trim() &&
      env.TWILIO_AUTH_TOKEN?.trim() &&
      (env.TWILIO_MESSAGING_SERVICE_SID?.trim() || env.TWILIO_FROM_NUMBER?.trim()),
  );
}

export async function sendSms(
  message: { to: string; body: string },
  { env = process.env, fetch: doFetch = fetch }: { env?: Env; fetch?: Fetch } = {},
): Promise<SmsResult> {
  if (!smsConfigured(env)) return { status: "skipped" };
  const sid = env.TWILIO_ACCOUNT_SID!.trim();
  const token = env.TWILIO_AUTH_TOKEN!.trim();
  const service = env.TWILIO_MESSAGING_SERVICE_SID?.trim();

  const form = new URLSearchParams({ To: message.to, Body: message.body });
  if (service) form.set("MessagingServiceSid", service);
  else form.set("From", env.TWILIO_FROM_NUMBER!.trim());

  try {
    const response = await doFetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${sid}:${token}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as { sid?: string; code?: number };
    if (response.ok) return { status: "sent", id: body.sid ?? "unknown" };
    if (body.code === TWILIO_OPTED_OUT) return { status: "opted_out" };
    // The body can echo the number; the status and Twilio's code are enough.
    return { status: "failed", error: `Twilio responded ${response.status}${body.code ? ` (${body.code})` : ""}` };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : "Unknown error" };
  }
}
