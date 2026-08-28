import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { currentUser, signIn } from "@/auth";
import { AuthShell } from "@/components/auth-shell";

export const dynamic = "force-dynamic";

/**
 * First-run entry point.
 *
 * Authentication is identical to /login — this exists because the moment of
 * highest drop-off is a client holding a welcome email, unsure whether the
 * thing in it is a "password" in the usual sense. Naming the screen after what
 * they were told to do ("click Get Started") and echoing the words from the
 * email removes that hesitation.
 */
export default async function GetStartedPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; expired?: string }>;
}) {
  const user = await currentUser();
  if (user) {
    if (user.mustChangePassword) redirect("/change-password");
    redirect(user.role === "admin" ? "/admin" : "/dashboard");
  }

  const params = await searchParams;
  const failed = Boolean(params.error);
  const expired = Boolean(params.expired);

  async function attempt(formData: FormData) {
    "use server";
    const identifier = String(formData.get("identifier") ?? "");
    const password = String(formData.get("password") ?? "");

    try {
      await signIn("credentials", { identifier, password, redirectTo: "/" });
    } catch (error) {
      if (error instanceof AuthError) redirect("/get-started?error=1");
      throw error;
    }
  }

  return (
    <AuthShell>
      <form action={attempt}>
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

        {expired && (
          <p className="error">
            That temporary password has expired. Contact us and we&rsquo;ll send
            you a new one — it only takes a moment.
          </p>
        )}

        {failed && (
          <p className="error">
            That didn&rsquo;t work. Check the username and temporary password
            from your email — they&rsquo;re easy to mistype, and the password
            has two words and six numbers, like{" "}
            <code>granite-kestrel-418302</code>.
          </p>
        )}

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
          Already set up your password? <Link href="/login">Sign in</Link>
        </p>
      </form>
    </AuthShell>
  );
}
