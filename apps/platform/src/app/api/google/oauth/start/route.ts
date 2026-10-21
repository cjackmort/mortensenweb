import { NextResponse } from "next/server";
import { currentUser } from "@/auth";
import { googleBusinessConfig } from "@/lib/google-business/config";
import { startAuthorization } from "@/lib/google-business/oauth";
import { OAUTH_COOKIE, OAUTH_COOKIE_PATH, OAUTH_TTL_SECONDS, sealOAuthState } from "@/lib/google-business/oauth-state";

/**
 * Start connecting the agency's Google account: send the operator to Google's
 * consent screen.
 *
 * Admin only. The state, the PKCE verifier and the operator's user id go in a
 * short-lived httpOnly cookie, signed; the callback refuses any code whose
 * state does not match it, or that comes back to a different signed-in user.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const user = await currentUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));
  if (user.role !== "admin" || user.status !== "active") return new Response(null, { status: 404 });

  const config = googleBusinessConfig();
  if (!config.ok) return NextResponse.redirect(new URL("/admin/google?connect=not_configured", request.url));

  const start = await startAuthorization(config.config);
  const cookie = await sealOAuthState({
    state: start.state,
    codeVerifier: start.codeVerifier,
    userId: user.userId,
    expiresAt: Date.now() + OAUTH_TTL_SECONDS * 1000,
  });

  const response = NextResponse.redirect(start.url);
  response.cookies.set(OAUTH_COOKIE, cookie, {
    httpOnly: true,
    secure: new URL(request.url).protocol === "https:",
    // Lax, not strict: Google's redirect back is a cross-site navigation, and
    // a strict cookie would not be sent on it.
    sameSite: "lax",
    path: OAUTH_COOKIE_PATH,
    maxAge: OAUTH_TTL_SECONDS,
  });
  return response;
}
