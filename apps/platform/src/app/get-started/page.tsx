import { AuthError } from "next-auth";
import { signIn } from "@/auth";
import { AuthForm, type AuthFormState } from "@/components/auth-form";
import { AuthShell } from "@/components/auth-shell";
import { ACCOUNT_CLOSED_MESSAGE, isAccountClosedError } from "@/lib/auth/account-closed";

/**
 * Prerendered and served from the CDN, like /login — see that page for why,
 * and why a signed-in visitor is no longer bounced from here. This page used
 * to do it with `currentUser()`, a database read on every view of the link in
 * the welcome email.
 */
export const dynamic = "error";

/**
 * First-run entry point.
 *
 * Authentication is identical to /login — this exists because the moment of
 * highest drop-off is a client holding a welcome email, unsure whether the
 * thing in it is a "password" in the usual sense. Naming the screen after what
 * they were told to do ("click Get Started") and echoing the words from the
 * email removes that hesitation.
 */
async function attempt(
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  "use server";
  const identifier = String(formData.get("identifier") ?? "");
  const password = String(formData.get("password") ?? "");

  try {
    await signIn("credentials", { identifier, password, redirectTo: "/" });
  } catch (error) {
    if (error instanceof AuthError) return isAccountClosedError(error) ? "closed" : "failed";
    throw error;
  }
  return null;
}

export default function GetStartedPage() {
  return (
    <AuthShell>
      <AuthForm
        action={attempt}
        header={
          <>
            <div className="auth-mark" aria-hidden="true">
              M
            </div>
            <h1 style={{ fontSize: "1.35rem", marginBottom: "0.25rem" }}>
              Welcome — let&rsquo;s get you set up
            </h1>
            <p className="muted" style={{ marginTop: 0, marginBottom: "1.5rem" }}>
              Enter the username and temporary password from your welcome email.
              You&rsquo;ll choose your own password on the next screen.
            </p>
          </>
        }
        closed={<p className="error">{ACCOUNT_CLOSED_MESSAGE}</p>}
        failed={
          <p className="error">
            That didn&rsquo;t work. Check the username and temporary password
            from your email — they&rsquo;re easy to mistype, and the password
            has two words and six numbers, like{" "}
            <code>granite-kestrel-418302</code>.
          </p>
        }
      >
        <label htmlFor="identifier">Username</label>
        <input
          id="identifier"
          name="identifier"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="northwind-comfort"
          required
        />

        <label htmlFor="password">Temporary password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="one-time-code"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
        />

        <button type="submit">Get started</button>

        <p
          className="muted"
          style={{ marginTop: "1.5rem", marginBottom: 0, fontSize: "0.85rem" }}
        >
          Already set up your password? <a href="/login">Sign in</a>
        </p>
      </AuthForm>
    </AuthShell>
  );
}
