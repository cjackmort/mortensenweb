"use client";

import { useActionState, type ReactNode } from "react";

/**
 * What a sign-in screen's server action reports back: nothing yet, a failure
 * to show above the fields, or done (the form is replaced by `done`).
 *
 * Success at signing in is not a state — `signIn` redirects, and the redirect
 * leaves this page.
 */
export type AuthFormState = "failed" | "done" | null;

export type AuthFormAction = (
  previous: AuthFormState,
  formData: FormData,
) => Promise<AuthFormState>;

/**
 * The form on the sign-in, get-started and forgot-password screens.
 *
 * Those pages are prerendered and served from the CDN, so the server cannot
 * read `?error=1` to decide what to render — the HTML is the same for every
 * visitor. The outcome comes back from the action instead, through
 * `useActionState`. That also saves the round trip the old redirect cost, and
 * it still works with JavaScript off: React posts the form, and the server
 * renders the page with the returned state.
 *
 * Only the form element and the outcome live on the client. The heading,
 * fields and copy arrive as server-rendered props, so this adds a few hundred
 * bytes to the page, not the markup.
 */
export function AuthForm({
  action,
  header,
  failed,
  done,
  children,
}: {
  action: AuthFormAction;
  header: ReactNode;
  /** Shown between the header and the fields after a failed attempt. */
  failed?: ReactNode;
  /** Replaces the whole form once the action reports done. */
  done?: ReactNode;
  children: ReactNode;
}) {
  const [state, formAction] = useActionState(action, null);

  if (state === "done" && done) return <>{done}</>;

  return (
    <form action={formAction}>
      {header}
      {state === "failed" && failed ? <div role="alert">{failed}</div> : null}
      {children}
    </form>
  );
}
