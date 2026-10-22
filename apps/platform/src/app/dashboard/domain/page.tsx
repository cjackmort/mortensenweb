import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { getDomainStep } from "@/db/repositories/client/domain";
import { REGISTRARS, registrarName, stepsFor } from "@/lib/domains/registrars";
import { formatDate, formatDateWithYear } from "@/lib/time";
import { DomainForm } from "./domain-form";
import "./domain.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Your domain",
  robots: { index: false, follow: false },
};

/**
 * Buying their own domain, after paying for the website.
 *
 * The client buys it at a registrar, in their own name, and gives us access
 * there — to that one domain, or to its DNS — so we can point it at the site
 * without ever having their password. Then they tell us here, which emails
 * the operator. The registrars, their prices and their steps come from
 * `lib/domains/registrars.ts`, where each was checked on the registrar's own
 * pages.
 */
export default async function DomainPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.role === "admin") redirect("/admin");
  if (!user.organizationId) redirect("/dashboard");

  const step = await getDomainStep(await getDb(), tenantContextFrom(user, user.organizationId));
  if (!step) redirect("/dashboard");
  const accessEmail = step.accessEmail ?? "the email address we gave you";

  return (
    <main className="shell">
      <div className="masthead">
        <h1>Your domain</h1>
      </div>
      <p className="page-intro">
        Your domain is your address, like yourbusiness.com. You buy it yourself, in your name, so it&rsquo;s yours and
        stays yours if you ever leave us.
      </p>
      <p className="notice">
        The domain isn&rsquo;t part of your payment to us. You pay the registrar for it each year, and it stays in your
        name.
      </p>

      {step.confirmedAt && step.domain && (
        <p className="notice notice-success" role="status">
          On {formatDate(step.confirmedAt)} you told us you&rsquo;d given us access to <strong>{step.domain}</strong>
          {step.registrar ? ` at ${registrarName(step.registrar)}` : ""}. We&rsquo;ll accept the invitation and point it
          at your new site. Nothing else to do.
        </p>
      )}

      <section aria-labelledby="domain-where">
        <h2 id="domain-where" className="domain-heading">
          Where to buy it
        </h2>
        <p className="muted">
          Any of these lets you give us access without sharing your password. When a step asks for our email, use{" "}
          <strong className="domain-access-email">{accessEmail}</strong>.
        </p>
        <div className="domain-registrars">
          {REGISTRARS.map((registrar) => (
            <article key={registrar.key} className="card domain-registrar">
              <div className="card-head">
                <h3>{registrar.name}</h3>
                <span className="domain-price">.com renews at {registrar.renewal}</span>
              </div>
              {registrar.priceNote && <p className="muted domain-note">{registrar.priceNote}</p>}
              <p className="domain-access">
                <span className="muted">What we get:</span> {registrar.access}
              </p>
              <ol className="domain-steps">
                {stepsFor(registrar, accessEmail).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ol>
              {registrar.watchOut.map((line) => (
                <p key={line} className="muted domain-note">
                  {line}
                </p>
              ))}
              <p className="domain-links">
                <a href={registrar.buyUrl} target="_blank" rel="noopener noreferrer">
                  Buy at {registrar.name} →
                </a>
                <span className="muted"> · Prices and steps checked {formatDateWithYear(`${registrar.checkedOn}T12:00:00Z`)}</span>
              </p>
            </article>
          ))}
        </div>
      </section>

      <section className="card" aria-labelledby="domain-done">
        <div className="card-head">
          <h2 id="domain-done">Tell us when it&rsquo;s done</h2>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          Once you&rsquo;ve bought it and sent us access, let us know here. We get an email straight away.
        </p>
        <DomainForm
          registrars={REGISTRARS.map((r) => ({ key: r.key, name: r.name }))}
          domain={step.domain}
          registrar={step.registrar}
        />
      </section>
    </main>
  );
}
