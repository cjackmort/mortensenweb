import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { findSiteForForms, recordLead } from "@/db/repositories/admin/leads";
import { parseSubmission, siteHookSecret, verifyNetlifySignature } from "@/lib/growth/netlify-forms";
import type { NetlifySubmissionPayload } from "@/lib/netlify/api";

/**
 * Netlify Forms' `submission_created` webhook: one contact-form submission
 * from one client site, into that client's leads inbox. It sends nothing —
 * Netlify's own notification email is what tells the client.
 *
 * Public under `/api/webhooks` in `proxy.ts`; the signature is the
 * authentication. Each site's hook signs with a secret derived from the master
 * secret and the site id in this URL, so a delivery that verifies here was
 * signed for *this* site — the path picks the inbox, and the signature proves
 * the path was not edited.
 *
 * The signature is checked before the site is looked up, so an unsigned
 * request learns nothing about which site ids exist: unknown and forged answer
 * the same 401.
 */

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sitePublicId: string }> },
): Promise<Response> {
  const master = process.env.NETLIFY_FORMS_WEBHOOK_SECRET;
  if (!master) {
    // Refuse rather than accept unverified deliveries: an endpoint that
    // stored anything while misconfigured would let anyone write into any
    // client's inbox. Netlify retries, so nothing is lost while it is fixed.
    return NextResponse.json({ error: "Webhook receiver is not configured." }, { status: 503 });
  }

  const { sitePublicId } = await params;

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }

  const valid = await verifyNetlifySignature(
    rawBody,
    request.headers.get("x-webhook-signature"),
    await siteHookSecret(master, sitePublicId),
  );
  if (!valid) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }

  let payload: NetlifySubmissionPayload;
  try {
    payload = JSON.parse(rawBody) as NetlifySubmissionPayload;
  } catch {
    // Signed but unreadable. Retrying will not make it readable, so it is
    // acknowledged; the six-hourly import reads the same submission from the
    // API if it was real.
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }
  const parsed = parseSubmission(payload ?? {});
  if (!parsed.ok) return NextResponse.json({ status: "ignored" }, { status: 200 });

  try {
    const db = await getDb();
    const site = await findSiteForForms(db, sitePublicId);
    // Archived since the hook was made. 200, so Netlify stops retrying a
    // delivery that will never have anywhere to go.
    if (!site) return NextResponse.json({ status: "ignored" }, { status: 200 });

    // No email from here. Netlify's own form notification already tells the
    // client someone wrote in; a second message from the portal about the same
    // enquiry was noise. The portal's job is the inbox and the reply.
    const result = await recordLead(db, site, parsed.lead);
    return NextResponse.json(
      { status: result.created ? "recorded" : "duplicate" },
      { status: 200 },
    );
  } catch (error) {
    console.error("[webhook:netlify-forms] processing failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    // 500 so Netlify retries. The submission id is the idempotency key, so a
    // retry after a partial failure cannot create a second lead.
    return NextResponse.json({ error: "Processing failed." }, { status: 500 });
  }
}

export async function GET(): Promise<Response> {
  return new Response(null, { status: 405 });
}
