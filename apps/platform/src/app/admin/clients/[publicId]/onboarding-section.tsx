import type { OnboardingView } from "@/db/repositories/admin/onboarding";
import type { OnboardingStepKey } from "@/lib/onboarding/status";
import { formatDate } from "@/lib/time";
import { DemoInviteForm, DemoUrlForm } from "./onboarding-forms";

/**
 * Onboarding, on the client overview: demo sent → login sent → password set
 * → paid, and the action for whichever comes next. Sending the login is the
 * existing Portal access form below; this points at it when it is next.
 */

function nextStep(view: OnboardingView, next: OnboardingStepKey | null) {
  switch (next) {
    case "demo":
      return view.demoUrl ? "Email them the demo and ask for a call." : "Save the demo URL, then email it to them.";
    case "login":
      return (
        <>
          Once they&rsquo;re happy with the demo, send their login.{" "}
          <a className="button" href="#portal-access">
            Send their login
          </a>
        </>
      );
    case "password":
      return "Login sent. Waiting for them to choose a password.";
    case "paid":
      return "They've set a password. Their order is waiting for them to pay.";
    default:
      return null;
  }
}

export function OnboardingSection({ clientPublicId, view }: { clientPublicId: string; view: OnboardingView }) {
  const paid = view.steps.find((s) => s.key === "paid")?.doneAt ?? null;
  const advice = nextStep(view, view.next);

  return (
    <section className="card" aria-labelledby="onboarding">
      <div className="card-head">
        <h2 id="onboarding">Onboarding</h2>
        {paid ? <span className="pill pill-success">Paid {formatDate(paid)}</span> : null}
      </div>

      <ol className="onboarding-steps">
        {view.steps.map((step, index) => {
          const state = step.doneAt ? "is-done" : step.key === view.next ? "is-next" : "";
          return (
            <li key={step.key} className={state}>
              <span className="onboarding-mark" aria-hidden="true">
                {step.doneAt ? "✓" : index + 1}
              </span>
              <span className="onboarding-step-text">
                <strong>{step.label}</strong>
                <span className="muted">
                  {step.doneAt ? formatDate(step.doneAt) : step.key === view.next ? "Next" : "Not yet"}
                </span>
              </span>
            </li>
          );
        })}
      </ol>

      {advice && <p className="onboarding-next">{advice}</p>}

      {!paid && (
        <>
          <DemoUrlForm clientPublicId={clientPublicId} demoUrl={view.demoUrl} />
          {view.demoUrl && (
            <DemoInviteForm
              clientPublicId={clientPublicId}
              draft={view.draft}
              open={view.next === "demo"}
              sentBefore={view.demoSentAt !== null}
            />
          )}
        </>
      )}
    </section>
  );
}
