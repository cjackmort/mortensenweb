import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth-shell";
import { getDb } from "@/db/client";
import { clientIpAddress } from "@/lib/auth/client-ip";
import {
  RESET_TOKEN_TTL_MINUTES,
  requestPasswordReset,
  resetLink,
} from "@/lib/auth/reset";
import { buildPasswordResetEmail } from "@/lib/email/password-reset";
import { sendEmail } from "@/lib/email/mailer";

export const dynamic = "force-dynamic";

/**
 * "I forgot my password."
 *
 * The screen has exactly one honest outcome. Whether the identifier matched an
 * account, matched a disabled one, or matched nothing at all, the client sees
 * the same confirmation — otherwise this form answers the question "is this
 * person a customer of yours?" for anyone who asks, which is both an
 * enumeration oracle and a privacy leak about who we work with.
 *
 * That symmetry is easy to break by accident later. If you add a message here,
 * check it renders identically for an address that does not exist.
 */
export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string }>;
}) {
  const params = await searchParams;
  const sent = Boolean(params.sent);

  async function submit(formData: FormData) {
    "use server";
    const identifier = String(formData.get("identifier") ?? "");

    const db = await getDb();
    const ipAddress = await clientIpAddress();
    const grant = await requestPasswordReset(db, identifier, { ipAddress });

    // Null covers unknown account, disabled account, and rate limited. All
    // three fall through to the same redirect below.
    if (grant) {
      const message = buildPasswordResetEmail({
        contactName: grant.name,
        resetUrl: resetLink(grant.token),
        expiresAt: grant.expiresAt,
        ttlMinutes: RESET_TOKEN_TTL_MINUTES,
      });
      // A mail failure is logged by the mailer and deliberately not surfaced:
      // "we could not send to that address" confirms the address exists.
      await sendEmail({ ...message, to: grant.email });
    }

    redirect("/forgot-password?sent=1");
  }

  if (sent) {
    return (
      <AuthShell>
        <div>
          <div className="auth-mark" aria-hidden="true">
            M
          </div>
          <h1 style={{ fontSize: "1.35rem", marginBottom: "0.25rem" }}>
            Check your email
          </h1>
          <p className="muted" style={{ marginTop: 0 }}>
            If that username or email belongs to an account, a link to choose a
            new password is on its way. It works once and expires in{" "}
            {RESET_TOKEN_TTL_MINUTES} minutes.
          </p>
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            Nothing arriving? Check the spam folder, and give it a minute before
            asking again — repeated requests are throttled.
          </p>
          <p style={{ marginTop: "1.5rem", marginBottom: 0, fontSize: "0.9rem" }}>
            <Link href="/login">Back to sign in</Link>
          </p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <form action={submit}>
        <div className="auth-mark" aria-hidden="true">
          M
        </div>
        <h1 style={{ fontSize: "1.35rem", marginBottom: "0.25rem" }}>
          Reset your password
        </h1>
        <p className="muted" style={{ marginTop: 0, marginBottom: "1.5rem" }}>
          Enter the username or email you sign in with and we&rsquo;ll send you
          a link to choose a new password.
        </p>

        <label htmlFor="identifier">Username or email</label>
        <input
          id="identifier"
          name="identifier"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
        />

        <button type="submit">Send the reset link</button>

        <p
          className="muted"
          style={{ marginTop: "1.5rem", marginBottom: 0, fontSize: "0.85rem" }}
        >
          Remembered it? <Link href="/login">Back to sign in</Link>
        </p>
      </form>
    </AuthShell>
  );
}
