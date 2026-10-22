/**
 * Outbound email.
 *
 * Development has no API key and therefore cannot send. That is a feature: a
 * half-configured environment that silently delivers real mail to a real client
 * is worse than one that refuses. Without `RESEND_API_KEY` the message is
 * written to the console and the send is reported as `skipped`, never as sent.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /**
   * Resend's own dedupe key, kept for 24 hours: a retry carrying the same key
   * is answered with the first email's id instead of sending a second.
   */
  idempotencyKey?: string;
  /**
   * Echoed back on Resend's webhooks, which is how `/api/webhooks/resend`
   * knows which feature and organization an event belongs to. Names and
   * values: ASCII letters, digits, `_` and `-`. See `lib/email/tags.ts`.
   */
  tags?: Array<{ name: string; value: string }>;

  /**
   * Overrides `RESEND_REPLY_TO` for this message. A reply to a lead sets it
   * to the client, so the customer's answer reaches the business rather than
   * us.
   */
  replyTo?: string;
  /**
   * Overrides `RESEND_FROM_ADDRESS`. Must still be an address on a domain
   * verified in Resend — only the display name is the business's.
   */
  from?: string;
  /** A silent copy, so the sender has a record of what went out. */
  bcc?: string;
  /**
   * Extra headers. A review request sets `List-Unsubscribe` and
   * `List-Unsubscribe-Post`, which Gmail and Yahoo require for one-click
   * unsubscribe from anything sent in bulk.
   */
  headers?: Record<string, string>;
}

export type SendResult =
  | { status: "sent"; id: string }
  | { status: "skipped"; reason: "no_api_key" }
  | {
      status: "failed";
      error: string;
      /** Resend's HTTP status, when it answered: 429 means slow down, not give up. */
      httpStatus?: number;
      /** From `Retry-After`, when Resend sent one. */
      retryAfterSeconds?: number;
    };

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export async function sendEmail(message: EmailMessage): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = message.from ?? process.env.RESEND_FROM_ADDRESS;

  if (!apiKey || !from) {
    console.info(
      [
        "",
        "──────────── EMAIL NOT SENT (no RESEND_API_KEY) ────────────",
        `To:      ${message.to}`,
        `Subject: ${message.subject}`,
        "",
        message.text,
        "────────────────────────────────────────────────────────────",
        "",
      ].join("\n"),
    );
    return { status: "skipped", reason: "no_api_key" };
  }

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(message.idempotencyKey ? { "Idempotency-Key": message.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        ...(message.bcc ? { bcc: [message.bcc] } : {}),
        ...(message.headers ? { headers: message.headers } : {}),
        subject: message.subject,
        text: message.text,
        html: message.html,
        ...(message.tags ? { tags: message.tags } : {}),
        ...(message.replyTo
          ? { reply_to: message.replyTo }
          : process.env.RESEND_REPLY_TO
            ? { reply_to: process.env.RESEND_REPLY_TO }
            : {}),
      }),
    });

    if (!response.ok) {
      // Body may contain the address; status text alone is safe to log.
      const retryAfter = Number(response.headers.get("retry-after"));
      return {
        status: "failed",
        error: `Resend responded ${response.status}`,
        httpStatus: response.status,
        ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
      };
    }

    const body = (await response.json()) as { id?: string };
    return { status: "sent", id: body.id ?? "unknown" };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
