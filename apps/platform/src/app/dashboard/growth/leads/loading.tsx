import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Leads" />
      <ListSkeleton title="Open" rows={4} />
    </main>
  );
}
