import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { sessionHint, signIn } from "@/auth";
import { AuthShell } from "@/components/auth-shell";

export const dynamic = "force-dynamic";

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
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // A signed-in visitor is bounced by the cookie alone — no database read on
  // the one page that every sign-in loads. The destination re-validates the
  // session properly; a stale cookie makes one extra hop and ends up back here.
  const hint = await sessionHint();
  if (hint) {
    if (hint.mustChangePassword) redirect("/change-password");
    redirect(hint.role === "admin" ? "/admin" : "/dashboard");
  }

  const params = await searchParams;
  const failed = Boolean(params.error);

  async function attempt(formData: FormData) {
    "use server";
    const identifier = String(formData.get("identifier") ?? "");
    const password = String(formData.get("password") ?? "");

    try {
      await signIn("credentials", { identifier, password, redirectTo: "/" });
    } catch (error) {
      // next-auth signals a successful redirect by throwing; let it through.
      if (error instanceof AuthError) redirect("/login?error=1");
      throw error;
    }
  }

  return (
    <AuthShell>
      <form action={attempt}>
        <div className="auth-mark" aria-hidden="true">
          M
        </div>
        <h1 style={{ fontSize: "1.35rem", marginBottom: "0.3rem" }}>
          Welcome back
        </h1>
        <p className="muted" style={{ marginTop: 0, marginBottom: "1.5rem" }}>
          Sign in to Mortensen Web Co.
        </p>

        {failed && (
          <p className="error">
            We could not sign you in. Check your details and try again.
          </p>
        )}

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

        <p
          style={{
            marginTop: "1rem",
            marginBottom: 0,
            fontSize: "0.9rem",
            textAlign: "center",
          }}
        >
          <Link href="/forgot-password">Forgot your password?</Link>
        </p>

        <p
          className="muted"
          style={{ marginTop: "1.5rem", marginBottom: 0, fontSize: "0.85rem" }}
        >
          First time here?{" "}
          <Link href="/get-started">Get started with your welcome email</Link>
        </p>
      </form>
    </AuthShell>
  );
}
