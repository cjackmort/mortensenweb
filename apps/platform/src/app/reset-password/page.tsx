import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { signIn } from "@/auth";
import { AuthShell } from "@/components/auth-shell";
import { getDb } from "@/db/client";
import {
  inspectResetToken,
  redeemPasswordReset,
  type ResetRedemption,
} from "@/lib/auth/reset";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

type FormError = Extract<ResetRedemption, { ok: false }>["reason"] | "mismatch";

const MESSAGES: Record<FormError, string> = {
  invalid: "That link is not valid. Request a new one below.",
  expired: "That link has expired. Request a new one below.",
  used: "That link has already been used. Request a new one below.",
  mismatch: "Those two passwords don't match. Please retype them.",
  too_short: `Please use at least ${MIN_PASSWORD_LENGTH} characters. Length matters far more than symbols — a short phrase you'll remember works well.`,
  too_long: "That password is too long. Please use fewer than 200 characters.",
  not_varied:
    "Please use a few more different characters — this one repeats too much.",
  same_as_temporary:
    "Please choose something different from the temporary password we sent you.",
};

/** Reasons the link itself is dead, as opposed to the password being rejected. */
const DEAD_LINK: ReadonlySet<string> = new Set(["invalid", "expired", "used"]);

/**
 * Choose a new password from an emailed link.
 *
 * The link is checked before the form renders, so a client following a stale
 * one is told immediately instead of typing a password twice and only then
 * being refused. Redemption re-checks it regardless — the pre-check is
 * courtesy, not the control.
 *
 * On success we sign in with the password just set. Redeeming advanced the
 * session epoch, so any session that existed is already dead; issuing a fresh
 * one here means the client lands on their dashboard rather than at a login
 * form they have just proven they can pass.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const params = await searchParams;
  const token = params.token ?? "";
  const errorKey = params.error as FormError | undefined;
  const errorMessage = errorKey ? MESSAGES[errorKey] : null;

  const db = await getDb();
  const state = await inspectResetToken(db, token);

  // A dead link gets its own screen with the one useful action on it.
  if (!state.ok || (errorKey && DEAD_LINK.has(errorKey))) {
    const reason = state.ok ? (errorKey as string) : state.reason;
    return (
      <AuthShell>
        <div>
          <div className="auth-mark" aria-hidden="true">
            M
          </div>
          <h1 style={{ fontSize: "1.35rem", marginBottom: "0.25rem" }}>
            This link no longer works
          </h1>
          <p className="muted" style={{ marginTop: 0 }}>
            {MESSAGES[reason as FormError] ?? MESSAGES.invalid}
          </p>
          <p style={{ marginTop: "1.5rem", marginBottom: "0.75rem" }}>
            <Link href="/forgot-password">Request a new reset link</Link>
          </p>
          <p style={{ margin: 0, fontSize: "0.9rem" }}>
            <Link href="/login">Back to sign in</Link>
          </p>
        </div>
      </AuthShell>
    );
  }

  async function submit(formData: FormData) {
    "use server";
    // Read from the form, never from the closure: the token must be the one
    // this submission carried.
    const submittedToken = String(formData.get("token") ?? "");
    const newPassword = String(formData.get("newPassword") ?? "");
    const confirmPassword = String(formData.get("confirmPassword") ?? "");
    const back = `/reset-password?token=${encodeURIComponent(submittedToken)}`;

    if (newPassword !== confirmPassword) {
      redirect(`${back}&error=mismatch`);
    }

    const database = await getDb();
    const result = await redeemPasswordReset(
      database,
      submittedToken,
      newPassword,
    );

    if (!result.ok) {
      redirect(`${back}&error=${result.reason}`);
    }

    try {
      await signIn("credentials", {
        identifier: result.email,
        password: newPassword,
        redirectTo: "/",
      });
    } catch (error) {
      // next-auth signals a successful redirect by throwing; let it through.
      if (error instanceof AuthError) redirect("/login");
      throw error;
    }
  }

  return (
    <AuthShell>
      <form action={submit}>
        <input type="hidden" name="token" value={token} />

        <div className="auth-mark" aria-hidden="true">
          M
        </div>
        <h1 style={{ fontSize: "1.35rem", marginBottom: "0.25rem" }}>
          Choose a new password
        </h1>
        <p className="muted" style={{ marginTop: 0, marginBottom: "1.5rem" }}>
          Pick something only you know. Signing you in happens automatically once
          it&rsquo;s saved.
        </p>

        {errorMessage && <p className="error">{errorMessage}</p>}

        <label htmlFor="newPassword">New password</label>
        <input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
        />

        <label htmlFor="confirmPassword">Confirm new password</label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
        />

        <p className="muted" style={{ fontSize: "0.8rem", margin: "0 0 1rem" }}>
          At least {MIN_PASSWORD_LENGTH} characters. A short phrase you&rsquo;ll
          remember is stronger than a short word with symbols in it.
        </p>

        <button type="submit">Save password and sign in</button>
      </form>
    </AuthShell>
  );
}
