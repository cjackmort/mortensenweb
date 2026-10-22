import type { OnboardingDomain, OnboardingView } from "@/db/repositories/admin/onboarding";
import type { OnboardingStepKey } from "@/lib/onboarding/status";
import { formatDate } from "@/lib/time";
import { DemoInviteForm, DemoUrlForm } from "./onboarding-forms";

/**
 * Onboarding, on the client overview: demo sent → login sent → password set
 * → paid → domain access, and the action for whichever comes next. Sending
 * the login is the existing Portal access form below; this points at it when
 * it is next. Once the client names their domain, the records to add for
 * Netlify are shown — the same `buildDnsRecords` the launch email uses.
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
    case "domain":
      return view.domain
        ? "They've named their domain but haven't confirmed access yet."
        : `Paid. Waiting for them to buy their domain and give us access${view.accessEmail ? ` (they're told to invite ${view.accessEmail})` : ""}.`;
    default:
      return null;
  }
}

function DomainPanel({ domain }: { domain: OnboardingDomain }) {
  return (
    <div className="onboarding-domain">
      <h3>Their domain</h3>
      <dl className="detail-grid">
        <dt>Domain</dt>
        <dd>{domain.name}</dd>
        <dt>Registrar</dt>
        <dd>{domain.registrar ?? "Not said"}</dd>
        <dt>Access</dt>
        <dd>{domain.accessConfirmedAt ? `They confirmed on ${formatDate(domain.accessConfirmedAt)}` : "Not confirmed"}</dd>
      </dl>
      {domain.records.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          No Netlify site name on their site yet, so there are no records to add. Set it under Website.
        </p>
      ) : (
        <>
          <p style={{ margin: "0 0 0.5rem" }}>
            Add these at {domain.registrar ?? "their registrar"} for <code>{domain.netlifySiteName}</code>:
          </p>
          <div className="table-wrap">
            <table className="stack onboarding-records">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Host</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {domain.records.map((record) => (
                  <tr key={`${record.type}:${record.host}`}>
                    <td data-label="Type">{record.type}</td>
                    <td data-label="Host">{record.host}</td>
                    <td data-label="Value">{record.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {domain.operatorNote && <p className="muted" style={{ margin: "0.5rem 0 0" }}>{domain.operatorNote}</p>}
        </>
      )}
    </div>
  );
}

export function OnboardingSection({ clientPublicId, view }: { clientPublicId: string; view: OnboardingView }) {
  const paid = view.steps.find((s) => s.key === "paid")?.doneAt ?? null;
  const finished = view.next === null;
  const advice = nextStep(view, view.next);

  return (
    <section className="card" aria-labelledby="onboarding">
      <div className="card-head">
        <h2 id="onboarding">Onboarding</h2>
        {finished ? (
          <span className="pill pill-success">Done</span>
        ) : paid ? (
          <span className="pill pill-success">Paid {formatDate(paid)}</span>
        ) : null}
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

      {view.domain && <DomainPanel domain={view.domain} />}

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
