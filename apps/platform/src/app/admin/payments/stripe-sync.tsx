import type { StripeSyncStatus } from "@/db/repositories/admin/stripe-reconcile";

/**
 * Whether Stripe and the portal agree, from the hourly check.
 *
 * Quiet by design and at the bottom of the page: a healthy sync is one line
 * of muted text. A payment that reached the portal only through the check is
 * spelled out with what to fix, because the usual cause, a signing secret
 * that does not match, is invisible from anywhere else in the portal.
 */
export function StripeSync({ status }: { status: StripeSyncStatus }) {
  if (!status.lastRunAt) {
    return <p className="pay-quiet">Stripe has not been checked against the portal yet.</p>;
  }

  const lastRun = status.lastRunAt.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const healthy = status.ok && status.needsReview.length === 0 && status.recoveredRecently === 0;

  if (healthy) {
    return <p className="pay-quiet">Stripe and the portal agree. Last checked {lastRun}.</p>;
  }

  return (
    <section className="card pay-sync">
      <div className="card-head">
        <h2>Stripe sync</h2>
        <span className="muted">checked {lastRun}</span>
      </div>

      {!status.ok && (
        <p className="error" style={{ marginTop: 0 }}>
          The last check could not reach Stripe{status.error ? `: ${status.error}` : "."}
        </p>
      )}

      {status.recoveredRecently > 0 && (
        <p style={{ marginTop: 0 }}>
          <span className="pill pill-warning">webhooks not arriving</span>{" "}
          {status.recoveredRecently} payment{status.recoveredRecently === 1 ? "" : "s"} reached
          the portal only through this hourly check, not from Stripe directly. In Stripe, open
          Developers → Webhooks → the portal endpoint and look at a failed delivery: a 401 means{" "}
          <code>STRIPE_WEBHOOK_SECRET</code> on Netlify does not match that endpoint&rsquo;s
          signing secret (change it, then redeploy).
        </p>
      )}

      {status.repaired.length > 0 && (
        <>
          <p className="muted" style={{ marginBottom: "0.4rem" }}>Fixed by the last check</p>
          <ul style={{ marginTop: 0 }}>
            {status.repaired.map((f) => (
              <li key={`${f.kind}:${f.reference}`}>{f.detail}</li>
            ))}
          </ul>
        </>
      )}

      {status.needsReview.length > 0 && (
        <>
          <p className="muted" style={{ marginBottom: "0.4rem" }}>Needs you</p>
          <ul style={{ marginTop: 0 }}>
            {status.needsReview.map((f) => (
              <li key={`${f.kind}:${f.reference}`}>{f.detail}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
