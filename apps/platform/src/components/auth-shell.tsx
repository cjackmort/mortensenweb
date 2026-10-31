import type { ReactNode } from "react";
import { PrivacyFooter } from "./privacy-link";
import { NoiseBackdrop } from "./noise-backdrop";

/**
 * The fixed-dark ground with a single card centered on it, shared by every
 * auth screen — sign in, get started, change/reset password, and the
 * dead-link state. The ground carries the same faint moving field as the
 * signed-in pages, in the blue-on-dark; it draws one still frame under
 * `prefers-reduced-motion` and nothing at all without WebGL.
 */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="auth-page">
      <NoiseBackdrop tone="dark" />
      <div className="auth-card">
        {children}
        <PrivacyFooter />
      </div>
    </main>
  );
}
