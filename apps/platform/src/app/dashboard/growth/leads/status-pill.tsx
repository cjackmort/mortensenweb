import type { LeadStatus } from "@/db/repositories/client/leads";

const PILL: Record<LeadStatus, { label: string; tone: string }> = {
  new: { label: "Not contacted", tone: "pill-warning" },
  contacted: { label: "Contacted", tone: "pill-info" },
  won: { label: "Won", tone: "pill-success" },
  lost: { label: "Lost", tone: "pill-neutral" },
  archived: { label: "Archived", tone: "pill-neutral" },
};

export function LeadStatusPill({ status }: { status: LeadStatus }) {
  const { label, tone } = PILL[status];
  return <span className={`pill ${tone}`}>{label}</span>;
}
