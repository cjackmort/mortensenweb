import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { currentUser, signIn } from "@/auth";
import { getDb } from "@/db/client";
import {
  MIN_PASSWORD_LENGTH,
  setOwnPassword,
  type PasswordRejection,
} from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const MESSAGES: Record<
  PasswordRejection | "invalid_current" | "mismatch",
  string
> = {
  invalid_current:
    "That temporary password wasn't right. Check your welcome email and try again.",
  mismatch: "Those two passwords don't match. Please retype them.",
  too_short: `Please use at least ${MIN_PASSWORD_LENGTH} characters. Length matters far more than symbols — a short phrase you'll remember works well.`,
  too_long: "That password is too long. Please use fewer than 200 characters.",
  not_varied:
    "Please use a few more different characters — this one repeats too much.",
  same_as_temporary:
    "Please choose something different from the temporary password we sent you.",
};

/**
 * Forced password change: the last step of onboarding.
 *
 * The temporary password was delivered by email, which means it has sat in an
 * inbox, possibly on a shared device. It is replaced before the client reaches
 * any real data, and `setOwnPassword` advances the session epoch so the emailed
 * credential stops working everywhere at that instant.
 *
 * Because the epoch advances, the caller's own token is invalidated too. We
 * therefore sign in again immediately with the password just chosen — held in
 * memory for exactly this purpose — so the client never sees a bounce back to
 * the login screen.
 */
export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");

  const params = await searchParams;
  const errorKey = params.error as keyof typeof MESSAGES | undefined;
  const errorMessage = errorKey ? MESSAGES[errorKey] : null;

  const isFirstRun = user.mustChangePassword;

  async function submit(formData: FormData) {
    "use server";
    const session = await currentUser();
    if (!session) redirect("/login");

    const currentPassword = String(formData.get("currentPassword") ?? "");
    const newPassword = String(formData.get("newPassword") ?? "");
    const confirmPassword = String(formData.get("confirmPassword") ?? "");

    if (newPassword !== confirmPassword) {
      redirect("/change-password?error=mismatch");
    }

    const db = await getDb();
    const result = await setOwnPassword(
      db,
      session.userId,
      currentPassword,
      newPassword,
    );

    if (!result.ok) {
      redirect(`/change-password?error=${result.reason}`);
    }

    // The epoch advanced, so the current token is now stale by design.
    // Re-issue one using the password we just set.
    try {
      await signIn("credentials", {
        identifier: session.email,
        password: newPassword,
        redirectTo: "/",
      });
    } catch (error) {
      if (error instanceof AuthError) redirect("/login");
      throw error;
    }
  }

  return (
    <main className="shell">
      <form className="form" action={submit}>
        <h1 style={{ fontSize: "1.25rem", marginBottom: "0.25rem" }}>
          {isFirstRun ? "Choose your password" : "Change your password"}
        </h1>
        <p className="muted" style={{ marginTop: 0, marginBottom: "1.5rem" }}>
          {isFirstRun
            ? "One last step. Pick a password only you know — the temporary one stops working as soon as you do."
            : "Enter your current password, then choose a new one."}
        </p>

        {errorMessage && <p className="error">{errorMessage}</p>}

        <label htmlFor="currentPassword">
          {isFirstRun ? "Temporary password" : "Current password"}
        </label>
        <input
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
        />

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

        <p
          className="muted"
          style={{ fontSize: "0.8rem", margin: "0 0 1rem" }}
        >
          At least {MIN_PASSWORD_LENGTH} characters. A short phrase you&rsquo;ll
          remember is stronger than a short word with symbols in it.
        </p>

        <button type="submit">
          {isFirstRun ? "Save password and continue" : "Update password"}
        </button>
      </form>
    </main>
  );
}
