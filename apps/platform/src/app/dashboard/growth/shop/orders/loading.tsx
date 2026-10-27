import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Orders" />
      <ListSkeleton title="Orders" rows={4} />
    </main>
  );
}
