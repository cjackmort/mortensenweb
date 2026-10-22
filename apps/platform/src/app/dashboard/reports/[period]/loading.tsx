import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Report" />
      <ListSkeleton title="At a glance" rows={5} />
      <ListSkeleton title="Visitors" rows={4} />
    </main>
  );
}
