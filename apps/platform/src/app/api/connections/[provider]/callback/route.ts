import { NextResponse } from "next/server";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { completeConnect, runAudit } from "@/db/repositories/client/connections";
import { isConnectionProvider, providerAdapter } from "@/lib/connections";
import { verifyOAuthState } from "@/lib/google-business/oauth-state";
import { CONNECT_COOKIE, CONNECT_COOKIE_PATH } from "../cookie";

/**
 * Where a provider sends the client back.
 *
 * The client arrives with their session; the `state` the provider echoes
 * must match the signed cookie the start route set for that same person. A
 * code arriving any other way is refused without being exchanged. Outcomes
 * go back to the page as a short code, never the provider's message.
 *
 * On success the first audit runs right away, so the page the client lands
 * on has something to show rather than "we'll look later".
 */

export const dynamic = "force-dynamic";

function back(request: Request, provider: string, outcome: string): Response {
  const response = NextResponse.redirect(new URL(`/dashboard/connections?connect=${provider}:${outcome}`, request.url));
  response.cookies.set(CONNECT_COOKIE, "", { path: CONNECT_COOKIE_PATH, maxAge: 0 });
  return response;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const user = await currentUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));
  const { provider } = await params;
  if (!isConnectionProvider(provider)) return new Response(null, { status: 404 });
  const adapter = providerAdapter(provider);
  if (adapter.connectWith !== "oauth") return new Response(null, { status: 404 });
  if (user.role !== "client" || !user.organizationId || user.viewingAs) return back(request, provider, "not_allowed");

  const url = new URL(request.url);
  if (url.searchParams.get("error")) return back(request, provider, "denied");

  const cookie = request.headers
    .get("cookie")
    ?.split(/;\s*/)
    .find((c) => c.startsWith(`${CONNECT_COOKIE}=`))
    ?.slice(CONNECT_COOKIE.length + 1);
  const check = await verifyOAuthState(cookie, { state: url.searchParams.get("state"), userId: user.userId });
  if (!check.ok) {
    console.warn("[connections] callback refused", { provider, reason: check.reason });
    return back(request, provider, "expired");
  }

  const code = url.searchParams.get("code");
  if (!code) return back(request, provider, "failed");

  const db = await getDb();
  const ctx = tenantContextFrom(user, user.organizationId);
  try {
    const grant = await adapter.complete({ code, codeVerifier: check.value.codeVerifier });
    await completeConnect(db, ctx, provider, grant);
  } catch (error) {
    console.error("[connections] connect failed", {
      provider,
      message: error instanceof Error ? error.message : "unknown",
    });
    return back(request, provider, "failed");
  }

  const first = await runAudit(db, ctx.organizationId, provider);
  return back(request, provider, first.ok ? "connected" : "connected_unread");
}
