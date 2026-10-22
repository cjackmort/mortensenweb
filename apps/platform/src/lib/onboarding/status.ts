/**
 * Where a new client has got to, from the operator's side.
 *
 * Demo sent → login sent → password set → paid → domain access. Each step is
 * read from what happened (an email that went out, an account created, a
 * password chosen, money recorded, the client saying they gave us access to
 * the domain they bought), never from a status somebody typed, so it cannot
 * say a client has paid before the money arrived.
 */

export type OnboardingStepKey = "demo" | "login" | "password" | "paid" | "domain";

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
  domainAccessAt: Date | null;
}

const LABELS: Record<OnboardingStepKey, string> = {
  demo: "Demo sent",
  login: "Login sent",
  password: "Password set",
  paid: "Paid",
  domain: "Domain access",
};

/**
 * The five steps, and the next one to do: the step after the furthest one
 * done. A client given a login without a demo email (most clients before
 * this existed) is not sent back to the demo. Null once the domain is in.
 */
export function onboardingSteps(facts: OnboardingFacts): { steps: OnboardingStep[]; next: OnboardingStepKey | null } {
  const steps: OnboardingStep[] = [
    { key: "demo", label: LABELS.demo, doneAt: facts.demoSentAt },
    { key: "login", label: LABELS.login, doneAt: facts.loginSentAt },
    { key: "password", label: LABELS.password, doneAt: facts.passwordSetAt },
    { key: "paid", label: LABELS.paid, doneAt: facts.paidAt },
    { key: "domain", label: LABELS.domain, doneAt: facts.domainAccessAt },
  ];
  const furthest = steps.reduce((last, step, index) => (step.doneAt ? index : last), -1);
  return { steps, next: steps[furthest + 1]?.key ?? null };
}
