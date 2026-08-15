import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { getDb } from "@/db/client";
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
 * Pinned to next-auth 5.0.0-beta.32 in package.json. It is a beta, so the
 * version is exact rather than caret-ranged; upgrades are deliberate.
 */

const EIGHT_HOURS = 60 * 60 * 8;

export const { handlers, signIn, signOut, auth } = NextAuth({
  session: {
    strategy: "jwt",
    maxAge: EIGHT_HOURS,
  },
  pages: {
    signIn: "/login",
  },
  trustHost: true,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(raw) {
        const email = typeof raw?.email === "string" ? raw.email : "";
        const password = typeof raw?.password === "string" ? raw.password : "";
        if (!email || !password) return null;

        const db = await getDb();
        const result = await authenticate(db, email, password);

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
