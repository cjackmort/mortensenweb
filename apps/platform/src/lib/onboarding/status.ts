/**
 * Where a new client has got to, from the operator's side.
 *
 * Demo sent → login sent → password set → paid. Each step is read from what
 * happened (an email that went out, an account created, a password chosen,
 * money recorded), never from a status somebody typed, so it cannot say a
 * client has paid before the money arrived.
 */

export type OnboardingStepKey = "demo" | "login" | "password" | "paid";

export interface OnboardingStep {
  key: OnboardingStepKey;
  label: string;
  doneAt: Date | null;
}

export interface OnboardingFacts {
  demoSentAt: Date | null;
  loginSentAt: Date | null;
  passwordSetAt: Date | null;
  paidAt: Date | null;
}

const LABELS: Record<OnboardingStepKey, string> = {
  demo: "Demo sent",
  login: "Login sent",
  password: "Password set",
  paid: "Paid",
};

/**
 * The four steps, and the next one to do: the step after the furthest one
 * done. A client given a login without a demo email (most clients before
 * this existed) is not sent back to the demo. Null once paid.
 */
export function onboardingSteps(facts: OnboardingFacts): { steps: OnboardingStep[]; next: OnboardingStepKey | null } {
  const steps: OnboardingStep[] = [
    { key: "demo", label: LABELS.demo, doneAt: facts.demoSentAt },
    { key: "login", label: LABELS.login, doneAt: facts.loginSentAt },
    { key: "password", label: LABELS.password, doneAt: facts.passwordSetAt },
    { key: "paid", label: LABELS.paid, doneAt: facts.paidAt },
  ];
  const furthest = steps.reduce((last, step, index) => (step.doneAt ? index : last), -1);
  return { steps, next: steps[furthest + 1]?.key ?? null };
}
