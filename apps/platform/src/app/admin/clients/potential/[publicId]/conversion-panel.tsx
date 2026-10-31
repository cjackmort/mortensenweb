import Link from "next/link";
import type { ConversionState } from "@/db/repositories/admin/conversion";
import type { StepStatus } from "@/db/repositories/admin/conversion-steps";

/**
 * "Convert to client", and what the last conversion did.
 *
 * The same conversion an agent runs through the operator API; this is the
 * door for the operator. Running it again repeats only the steps that did not
 * finish, so the button stays after a partial run and says so.
 */

const STEP_LABELS: Record<string, string> = {
  client: "Client record",
  site: "Concept site carried over",
  allowlist: "Automated work allowed",
  repo_secrets: "Repository tokens",
  agent_workflow: "Agent workflow",
  deploy_workflow: "Deploy workflow",
  netlify_site_variable: "NETLIFY_SITE_ID",
  leads_inbox: "Leads inbox",
  analytics: "Umami website",
  analytics_snippet: "Analytics id on the site",
  business_profile: "General information",
  site_kinds: "Booking and shop",
  prospect_converted: "Off the potential list",
  client_invite: "Sign-in email",
  search_console: "Search Console",
  google_calendar: "Google Calendar",
  stripe_connect: "Stripe",
};

const PILL: Record<StepStatus, string> = {
  ok: "pill pill-success",
  failed: "pill pill-danger",
  manual: "pill pill-warning",
  skipped: "pill pill-neutral",
};

export function ConversionPanel({
  businessName,
  conversion,
  convert,
}: {
  businessName: string;
  conversion: ConversionState;
  convert: (formData: FormData) => Promise<void>;
}) {
  const report = conversion.report;
  const finished = conversion.state === "finished" && report?.complete;

  return (
    <section className="card" id="conversion" style={{ maxWidth: "34rem" }}>
      <div className="card-head">
        <h2>{report ? "Conversion" : "Convert to client"}</h2>
      </div>

      {conversion.state === "running" && (
        <p className="notice notice-info">A conversion is running. Refresh in a minute for its report.</p>
      )}

      {!report && (
        <p className="field-hint" style={{ marginTop: 0 }}>
          For when they say yes. Makes {businessName} a client, keeps the concept site, and connects
          the repository, deploys, leads inbox, analytics and General information. They pay to go
          live from their portal; nothing is charged here.
        </p>
      )}

      {report && (
        <>
          {report.clientId && (
            <p style={{ marginTop: 0 }}>
              <Link href={`/admin/clients/${report.clientId}`}>Open the client</Link>
              {report.siteUrl && (
                <>
                  {" · "}
                  <a href={report.siteUrl} target="_blank" rel="noreferrer">
                    Their site
                  </a>
                </>
              )}
            </p>
          )}
          <ul style={{ listStyle: "none", padding: 0, margin: "0 0 1rem" }}>
            {report.steps.map((step) => (
              <li key={step.id} style={{ marginBottom: "0.6rem" }}>
                <span className={PILL[step.status]}>{step.status}</span>{" "}
                <strong>{STEP_LABELS[step.id] ?? step.id}</strong>
                <div className="field-hint" style={{ margin: "0.2rem 0 0", overflowWrap: "anywhere" }}>
                  {step.detail}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {!finished && conversion.state !== "running" && (
        <form action={convert}>
          <label className="checkbox">
            <input type="checkbox" name="invite" />
            <span>Also email them their sign-in (a temporary password goes to the contact email)</span>
          </label>
          <button type="submit">{report ? "Run the unfinished steps again" : "Convert to client"}</button>
        </form>
      )}
    </section>
  );
}
