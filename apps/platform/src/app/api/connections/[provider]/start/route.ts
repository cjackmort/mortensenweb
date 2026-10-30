import { NextResponse } from "next/server";
import { currentUser } from "@/auth";
import { connectionHome, isConnectionProvider, providerAdapter } from "@/lib/connections";
import { OAUTH_TTL_SECONDS, sealOAuthState } from "@/lib/google-business/oauth-state";
import { CONNECT_COOKIE, CONNECT_COOKIE_PATH } from "../cookie";

/**
 * Send the client to the provider's consent screen.
 *
 * Clients only, with an organization, and never while an operator is viewing
 * as the client — a connection is the client's own grant. The state (and the
 * PKCE verifier where the provider uses one) goes in a short-lived signed
 * cookie; the callback refuses anything that does not match it.
 */

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const user = await currentUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));
  const { provider } = await params;
  if (!isConnectionProvider(provider)) return new Response(null, { status: 404 });
  if (user.role !== "client" || !user.organizationId || user.viewingAs) {
    return NextResponse.redirect(new URL(`${connectionHome(provider)}?connect=${provider}:not_allowed`, request.url));
  }

  const adapter = providerAdapter(provider);
  // A provider connected by key has no consent screen to send anyone to.
  if (adapter.connectWith !== "oauth") return new Response(null, { status: 404 });
  if (!adapter.configured().ok) {
    return NextResponse.redirect(new URL(`${connectionHome(provider)}?connect=${provider}:not_configured`, request.url));
  }

  const state = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
  const begun = await adapter.begin({ state });
  const cookie = await sealOAuthState({
    state,
    codeVerifier: begun.codeVerifier,
    userId: user.userId,
    expiresAt: Date.now() + OAUTH_TTL_SECONDS * 1000,
  });

  const response = NextResponse.redirect(begun.url);
  response.cookies.set(CONNECT_COOKIE, cookie, {
    httpOnly: true,
    secure: new URL(request.url).protocol === "https:",
    // Lax: the provider's redirect back is a cross-site navigation.
    sameSite: "lax",
    path: CONNECT_COOKIE_PATH,
    maxAge: OAUTH_TTL_SECONDS,
  });
  return response;
}
