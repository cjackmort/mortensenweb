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
}

export type SendResult =
  | { status: "sent"; id: string }
  | { status: "skipped"; reason: "no_api_key" }
  | { status: "failed"; error: string };

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export async function sendEmail(message: EmailMessage): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_ADDRESS;

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
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
        ...(process.env.RESEND_REPLY_TO
          ? { reply_to: process.env.RESEND_REPLY_TO }
          : {}),
      }),
    });

    if (!response.ok) {
      // Body may contain the address; status text alone is safe to log.
      return { status: "failed", error: `Resend responded ${response.status}` };
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
