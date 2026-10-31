import { AuthError } from "next-auth";
import { signIn } from "@/auth";
import { AuthForm, type AuthFormState } from "@/components/auth-form";
import { AuthShell } from "@/components/auth-shell";
import { ACCOUNT_CLOSED_MESSAGE, isAccountClosedError } from "@/lib/auth/account-closed";

/**
 * Prerendered, and the build fails if anything here makes it dynamic.
 *
 * This is the page every visit without a session lands on, so it is served
 * from the CDN rather than rendered per request. It used to read the session
 * cookie to bounce a signed-in visitor onward, which made every view a
 * function invocation. That bounce also looped: a revoked session still
 * decodes, so /login sent it to /dashboard, which rejected it back to /login.
 * A signed-in visitor now simply sees the form; `/` is still the router.
 */
export const dynamic = "error";

/**
 * Sign-in for returning users.
 *
 * One error message covers every failure mode — wrong password, unknown
 * account, disabled account, rate limited. Distinguishing them would turn this
 * form into an account enumeration oracle.
 *
 * First-time clients are sent to /get-started instead, which is the same
 * authentication with onboarding framing.
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
    // next-auth signals a successful redirect by throwing; let it through.
    if (error instanceof AuthError) return isAccountClosedError(error) ? "closed" : "failed";
    throw error;
  }
  return null;
}

export default function LoginPage() {
  return (
    <AuthShell>
      <AuthForm
        action={attempt}
        header={
          <>
            <div className="auth-mark" aria-hidden="true">
              M
            </div>
            <h1 style={{ fontSize: "1.35rem", marginBottom: "0.3rem" }}>
              Welcome back
            </h1>
            <p className="muted" style={{ marginTop: 0, marginBottom: "1.5rem" }}>
              Sign in to Mortensen Web Co.
            </p>
          </>
        }
        closed={<p className="error">{ACCOUNT_CLOSED_MESSAGE}</p>}
        failed={
          <p className="error">
            We could not sign you in. Check your details and try again.
          </p>
        }
      >
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

        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />

        <button type="submit">Sign in</button>

        {/*
         * Plain links, not next/link: the targets are static pages on the
         * CDN, and next/link would add its runtime to this page and prefetch
         * both on every view.
         */}
        <p
          style={{
            marginTop: "1rem",
            marginBottom: 0,
            fontSize: "0.9rem",
            textAlign: "center",
          }}
        >
          <a href="/forgot-password">Forgot your password?</a>
        </p>

        <p
          className="muted"
          style={{ marginTop: "1.5rem", marginBottom: 0, fontSize: "0.85rem" }}
        >
          First time here?{" "}
          <a href="/get-started">Get started with your welcome email</a>
        </p>
      </AuthForm>
    </AuthShell>
  );
}
