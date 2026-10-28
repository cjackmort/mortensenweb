import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Shop settings" />
      <ListSkeleton title="Payments" rows={2} />
      <ListSkeleton title="Orders" rows={4} />
    </main>
  );
}
