/**
 * One output's status, named, so a row of three reads as "Website: Waiting ·
 * Graphics: Ready · Google: Post manually" to a screen reader as well as by
 * eye.
 */
export function OutputPill({
  name,
  label,
  tone,
}: {
  name: string;
  label: string;
  tone: "success" | "accent" | "info" | "warning" | "neutral";
}) {
  return (
    <span className="showcase-output">
      <span className="showcase-output-name">{name}</span>
      <span className={`pill pill-${tone}`}>{label}</span>
    </span>
  );
}
