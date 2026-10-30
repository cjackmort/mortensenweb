import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

/**
 * Shown the instant this route is requested, replaced when the page streams in.
 * See `components/skeletons.tsx` for why the shapes match the real panels.
 */
export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Payments" />
      <ListSkeleton title="Clients" rows={5} />
      <ListSkeleton title="Overdue" rows={2} />
      <ListSkeleton title="Ledger" rows={4} />
    </main>
  );
}
