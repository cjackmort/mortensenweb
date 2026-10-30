import Link from "next/link";
import { getDb } from "@/db/client";
import type { TenantContext } from "@/db/repositories/context";
import { getOnboarding } from "@/db/repositories/client/onboarding";
import { ProgressMeter } from "./progress-meter";
import "./get-started.css";

/**
 * One line on the home page while a new client still has a required to-do:
 * how far through Get started they are, and what is next.
 *
 * Gone once the required to-dos are done, the same rule that keeps the tab
 * (`sections.ts`), so the two never disagree. A failed read loses the line,
 * never the page: Get started is still a tab away.
 */
export async function GetStartedBanner({ ctx }: { ctx: TenantContext }) {
  let onboarding;
  try {
    onboarding = await getOnboarding(await getDb(), ctx, { passwordChosen: true });
  } catch (error) {
    console.error("[dashboard] get started banner failed", error);
    return null;
  }
  if (!onboarding || onboarding.progress.requiredLeft === 0) return null;

  const { progress, todos } = onboarding;
  const next = todos.find((t) => t.required && !t.done) ?? todos.find((t) => !t.done);

  return (
    <Link href="/dashboard/get-started" className="get-started-banner">
      <span className="get-started-banner-label">
        <strong>Get started</strong> · {progress.label}
      </span>
      <ProgressMeter done={progress.done} total={progress.total} compact />
      {next && <span className="get-started-banner-next">Next: {next.title}</span>}
    </Link>
  );
}
