import { NextResponse } from "next/server";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import { completeGoogleConnect } from "@/db/repositories/admin/google-connection";
import { OAUTH_COOKIE, OAUTH_COOKIE_PATH, verifyOAuthState } from "@/lib/google-business/oauth-state";

/**
 * Where Google sends the operator back after the consent screen.
 *
 * Registered in the Google Cloud OAuth client as exactly
 * `https://portal.mortensenweb.com/api/google/oauth/callback` (and the
 * localhost equivalent). Not public: the operator arrives with their session
 * cookie, `currentUser()` must be an active admin, and the `state` Google
 * echoes must match the signed cookie the start route set for that same
 * operator. A code arriving any other way is refused without being exchanged.
 *
 * Outcomes are passed back as a short code in the query string, never
 * Google's message or anything about the token.
 */

export const dynamic = "force-dynamic";

function back(request: Request, outcome: string): Response {
  const response = NextResponse.redirect(new URL(`/admin/google?connect=${outcome}`, request.url));
  response.cookies.set(OAUTH_COOKIE, "", { path: OAUTH_COOKIE_PATH, maxAge: 0 });
  return response;
}

export async function GET(request: Request): Promise<Response> {
  const user = await currentUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));
  if (user.role !== "admin" || user.status !== "active") return new Response(null, { status: 404 });

  const url = new URL(request.url);
  if (url.searchParams.get("error")) return back(request, "denied");

  const cookie = request.headers
    .get("cookie")
    ?.split(/;\s*/)
    .find((c) => c.startsWith(`${OAUTH_COOKIE}=`))
    ?.slice(OAUTH_COOKIE.length + 1);
  const check = await verifyOAuthState(cookie, { state: url.searchParams.get("state"), userId: user.userId });
  if (!check.ok) {
    console.warn("[google] OAuth callback refused", { reason: check.reason });
    return back(request, "expired");
  }

  const code = url.searchParams.get("code");
  if (!code) return back(request, "failed");

  const result = await completeGoogleConnect(adminContextFrom(user), await getDb(), {
    code,
    codeVerifier: check.value.codeVerifier,
  });
  if (!result.ok) return back(request, "failed");
  return back(request, result.status.state === "no_access" ? "no_access" : "connected");
}
