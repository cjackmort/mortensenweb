import Link from "next/link";

const STEPS = [
  { key: "edit", label: "Your ad" },
  { key: "channels", label: "Where and how much" },
  { key: "checkout", label: "Pay" },
] as const;

export type AdStep = (typeof STEPS)[number]["key"];

/**
 * The three steps of creating an ad. Earlier steps are links, so a client can
 * go back and change something; later ones are not, because each step saves
 * what the next one needs.
 */
export function AdSteps({ campaign, current }: { campaign: string; current: AdStep }) {
  const at = STEPS.findIndex((s) => s.key === current);
  return (
    <ol className="ad-steps" aria-label="Steps">
      {STEPS.map((step, i) => (
        <li key={step.key} aria-current={i === at ? "step" : undefined} data-done={i < at || undefined}>
          <span className="ad-steps-n">{i + 1}</span>
          {i < at ? <Link href={`/dashboard/growth/ads/${campaign}/${step.key}`}>{step.label}</Link> : step.label}
        </li>
      ))}
    </ol>
  );
}
