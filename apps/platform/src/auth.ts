import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { getDb } from "@/db/client";
import { ipFromHeaders } from "@/lib/auth/client-ip";
import { authenticate, resolveSession } from "@/lib/auth/session";

/**
 * Auth.js configuration.
 *
 * JWT session strategy with no database adapter. That combination is
 * deliberate: it keeps the session layer free of adapter code, and the token
 * is never trusted on its own — `resolveSession` re-reads the user row on
 * every request and compares `sessionEpoch`, so revocation is immediate rather
 * than waiting for token expiry.
 *
 * That last part is what makes a 30-day session safe rather than reckless. In
 * a system where the token itself is the only check, a long `maxAge` means a
 * stolen or outdated token keeps working for a month. Here it doesn't: a
 * password change, a reissued credential or an admin disabling the account
 * advances `sessionEpoch` (see session.ts), and the very next request from
 * every other signed-in device is rejected regardless of how much of the 30
 * days is left on its cookie. Long-lived and instantly revocable are not in
 * tension here — the second is what pays for the first.
 *
 * `updateAge` re-issues the cookie with a fresh 30-day window once a day of
 * activity has passed, rather than on every request — so a client who opens
 * the portal every few days never sees the login screen, but a browser closed
 * for a month does, without writing a new cookie on every single page view in
 * between.
 *
 * Pinned to next-auth 5.0.0-beta.32 in package.json. It is a beta, so the
 * version is exact rather than caret-ranged; upgrades are deliberate.
 */

const THIRTY_DAYS = 60 * 60 * 24 * 30;
const ONE_DAY = 60 * 60 * 24;

export const { handlers, signIn, signOut, auth } = NextAuth({
  session: {
    strategy: "jwt",
    maxAge: THIRTY_DAYS,
    updateAge: ONE_DAY,
  },
  pages: {
    signIn: "/login",
  },
  trustHost: true,
  providers: [
    Credentials({
      credentials: {
        // Accepts the issued handle (`northwind-comfort`) or the email address.
        identifier: { label: "Username or email", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(raw, request) {
        const identifier =
          typeof raw?.identifier === "string" ? raw.identifier : "";
        const password = typeof raw?.password === "string" ? raw.password : "";
        if (!identifier || !password) return null;

        const db = await getDb();
        // Without this the per-IP limit in `authenticate` is dead code: it
        // guards on `context.ipAddress`, so omitting it silently leaves only
        // the per-account limit, and one attacker spreading guesses across many
        // accounts is never throttled at all.
        const ipAddress = request?.headers
          ? ipFromHeaders(request.headers as Headers)
          : undefined;
        const result = await authenticate(db, identifier, password, {
          ipAddress,
        });

        // Every failure returns null. The caller renders one message for all
        // of them, so login cannot be used to enumerate accounts.
        if (!result.ok) return null;

        return {
          id: result.user.userId,
          email: result.user.email,
          name: result.user.name ?? undefined,
          role: result.user.role,
          organizationId: result.user.organizationId,
          sessionEpoch: result.user.sessionEpoch,
          mustChangePassword: result.user.mustChangePassword,
        } as never;
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        const u = user as unknown as {
          id: string;
          role: "admin" | "client";
          organizationId: string | null;
          sessionEpoch: number;
          mustChangePassword: boolean;
        };
        token.userId = u.id;
        token.role = u.role;
        token.organizationId = u.organizationId;
        token.sessionEpoch = u.sessionEpoch;
        token.mustChangePassword = u.mustChangePassword;
      }
      return token;
    },
    async session({ session, token }) {
      (session as unknown as Record<string, unknown>).userId = token.userId;
      (session as unknown as Record<string, unknown>).role = token.role;
      (session as unknown as Record<string, unknown>).organizationId =
        token.organizationId;
      (session as unknown as Record<string, unknown>).sessionEpoch =
        token.sessionEpoch;
      (session as unknown as Record<string, unknown>).mustChangePassword =
        token.mustChangePassword;
      return session;
    },
  },
});

/**
 * The authoritative check for server components and route handlers.
 *
 * Re-validates the token's claims against the database, so a disabled account
 * or a bumped `sessionEpoch` stops working immediately.
 */
export async function currentUser() {
  const session = await auth();
  if (!session) return null;

  const claims = session as unknown as {
    userId?: string;
    sessionEpoch?: number;
  };
  const db = await getDb();
  return resolveSession(db, claims);
}
