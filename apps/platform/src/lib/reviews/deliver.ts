import type { EmailMessage, SendResult } from "@/lib/email/mailer";
import { featureTags } from "@/lib/email/tags";
import { reviewLinks } from "./links";
import { buildReviewEmail, buildReviewSms } from "./message";
import type { SmsResult } from "./sms";
import type { ReviewTemplate } from "./template";

/**
 * Send one review request, or its reminder, on the channels the caller has
 * already decided may be used.
 *
 * Deciding is the caller's job — consent, suppression, whether texting is
 * set up — because the initial send and the reminder decide differently. This
 * only builds the messages, sends them, and reports what happened to each.
 *
 * Every email, the reminder included, is tagged with the business and the
 * request, so a bounce or a spam complaint on it finds its way back
 * (`applyReviewDeliveryEvent`, via `/api/webhooks/resend`).
 */

export type ChannelOutcome = "sent" | "failed" | "not_sent";

/** The tag holding the request's public id; Resend echoes it on every event. */
export const REVIEW_REQUEST_TAG = "review_request";

export interface DeliveryInput {
  publicId: string;
  organizationId: string;
  customerName: string;
  email: string | null;
  phone: string | null;
  useEmail: boolean;
  useSms: boolean;
  businessName: string;
  replyTo: string | null;
  postalAddress: string | null;
  /** Our verified sending address. Null leaves email `not_sent`. */
  senderAddress: string | null;
  template: ReviewTemplate;
  reminder: boolean;
}

export interface DeliveryDeps {
  send: (message: EmailMessage) => Promise<SendResult>;
  text: (message: { to: string; body: string }) => Promise<SmsResult>;
  env: Record<string, string | undefined>;
}

export interface DeliveryResult {
  email: ChannelOutcome | null;
  sms: ChannelOutcome | null;
  /** The number replied STOP at some point; the caller suppresses it. */
  smsOptedOut: boolean;
  error: string | null;
}

function fromEmail(result: SendResult): ChannelOutcome {
  return result.status === "sent" ? "sent" : result.status === "skipped" ? "not_sent" : "failed";
}

export async function deliverReviewRequest(input: DeliveryInput, deps: DeliveryDeps): Promise<DeliveryResult> {
  const result: DeliveryResult = { email: null, sms: null, smsOptedOut: false, error: null };
  const links = await reviewLinks(input.publicId, deps.env);
  if (!links) {
    return {
      ...result,
      email: input.useEmail ? "failed" : null,
      sms: input.useSms ? "failed" : null,
      error: "Review links could not be signed (AUTH_URL or AUTH_SECRET unset).",
    };
  }

  if (input.useEmail && input.email) {
    if (!input.senderAddress) {
      result.email = "not_sent";
    } else {
      const sent = await deps.send({
        ...buildReviewEmail({
          to: input.email,
          customerName: input.customerName,
          businessName: input.businessName,
          senderAddress: input.senderAddress,
          replyTo: input.replyTo,
          postalAddress: input.postalAddress,
          template: {
            subject: input.template.subject,
            body: input.reminder ? input.template.reminderBody : input.template.body,
          },
          ...links,
        }),
        tags: featureTags("reviews", input.organizationId, { [REVIEW_REQUEST_TAG]: input.publicId }),
      });
      result.email = fromEmail(sent);
      if (sent.status === "failed") result.error = sent.error.slice(0, 500);
    }
  }

  if (input.useSms && input.phone) {
    const sent = await deps.text({
      to: input.phone,
      body: buildReviewSms({
        customerName: input.customerName,
        businessName: input.businessName,
        reviewLink: links.reviewLink,
        reminder: input.reminder,
      }),
    });
    if (sent.status === "opted_out") {
      result.smsOptedOut = true;
      result.sms = "not_sent";
    } else {
      result.sms = sent.status === "sent" ? "sent" : sent.status === "skipped" ? "not_sent" : "failed";
      if (sent.status === "failed") result.error = sent.error.slice(0, 500);
    }
  }

  return result;
}
