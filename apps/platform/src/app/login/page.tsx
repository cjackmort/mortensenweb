import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { currentUser, signIn } from "@/auth";

export const dynamic = "force-dynamic";

/**
 * Sign-in.
 *
 * One error message covers every failure mode — wrong password, unknown
 * account, disabled account, rate limited. Distinguishing them would turn this
 * form into an account enumeration oracle.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await currentUser();
  if (user) redirect(user.role === "admin" ? "/admin" : "/dashboard");

  const params = await searchParams;
  const failed = Boolean(params.error);

  async function attempt(formData: FormData) {
    "use server";
    const email = String(formData.get("email") ?? "");
    const password = String(formData.get("password") ?? "");

    try {
      await signIn("credentials", { email, password, redirectTo: "/" });
    } catch (error) {
      // next-auth signals a successful redirect by throwing; let it through.
      if (error instanceof AuthError) redirect("/login?error=1");
      throw error;
    }
  }

  return (
    <main className="shell">
      <form className="form" action={attempt}>
        <h1 style={{ fontSize: "1.1rem", marginBottom: "0.25rem" }}>
          Mortensen Web Co.
        </h1>
        <p className="muted" style={{ marginTop: 0, marginBottom: "1.5rem" }}>
          Client &amp; administration portal
        </p>

        {failed && (
          <p className="error">
            We could not sign you in. Check your email and password and try
            again.
          </p>
        )}

        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
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
      </form>
    </main>
  );
}
