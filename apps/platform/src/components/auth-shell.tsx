import type { ReactNode } from "react";

/**
 * Full-bleed photo backdrop with a single frosted card centered on it,
 * shared by every auth screen — sign in, get started, change/reset
 * password, and the dead-link state. Static on purpose: the previous
 * version's drifting canvas smoke was traded for a fixed photograph, so
 * there is nothing here for `prefers-reduced-motion` to need to disable.
 */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="auth-page">
      <div className="auth-card">{children}</div>
    </main>
  );
}
