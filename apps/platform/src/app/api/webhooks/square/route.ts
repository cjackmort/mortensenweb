import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { processSquareDelivery } from "@/db/repositories/admin/square-webhooks";
import { verifySquareSignature } from "@/lib/webhooks/signature";

/**
 * Square's webhook endpoint.
 *
 * Same shape as the GitHub receiver, for the same reasons: the raw body is read
 * once and verified before anything parses it, failures are acknowledged rather
 * than retried into oblivion, and a bad signature is the one case that answers
 * with an error.
 *
 * ## The notification URL is part of the signature
 *
 * Square signs `notificationUrl + rawBody`, not the body alone. That is what
 * stops a signature captured from one endpoint being replayed against another,
 * and it means `SQUARE_WEBHOOK_NOTIFICATION_URL` must be byte-identical to the
 * value configured in their dashboard.
 *
 * It is read from configuration rather than reconstructed from the request.
 * Building it from headers would let a `Host` header decide what we verify
 * against, which defeats the point of including it.
 */

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1024 * 1024;

export async function POST(request: Request): Promise<Response> {
  const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  const notificationUrl = process.env.SQUARE_WEBHOOK_NOTIFICATION_URL;

  if (!signatureKey || !notificationUrl) {
    // Refuse rather than accept unverified notifications. An endpoint that
    // processes anything while misconfigured is worse than one that is down:
    // this one confirms payments and unlocks paid features, so anybody who
    // found the URL could grant themselves an account.
    return NextResponse.json(
      { error: "Webhook receiver is not configured." },
      { status: 503 },
    );
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }

  const signature = request.headers.get("x-square-hmacsha256-signature");
  const signatureValid = await verifySquareSignature(
    rawBody,
    signature,
    signatureKey,
    notificationUrl,
  );

  let payload: unknown = null;
  if (signatureValid) {
    try {
      payload = JSON.parse(rawBody);
    } catch {
      payload = null;
    }
  }

  const db = await getDb();

  try {
    const outcome = await processSquareDelivery(db, {
      payload,
      signatureValid,
      // Square's idempotency key is `event_id` inside the body. When the body
      // could not be parsed there is nothing to key on, so a digest of the raw
      // bytes stands in — two identical unparseable deliveries then collapse to
      // one row instead of accumulating.
      fallbackId: await digest(rawBody),
    });

    if (outcome.status === "rejected" && !signatureValid) {
      return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
    }

    return NextResponse.json({ status: outcome.status }, { status: 200 });
  } catch (error) {
    console.error("[webhook:square] processing failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    // 500 so Square retries. The delivery row is already marked failed and the
    // event id is the idempotency key, so a retry cannot double-confirm.
    return NextResponse.json({ error: "Processing failed." }, { status: 500 });
  }
}

async function digest(body: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function GET(): Promise<Response> {
  return new Response(null, { status: 405 });
}
