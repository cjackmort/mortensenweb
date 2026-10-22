import { ListSkeleton, MastheadSkeleton, VisitorsSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Google profile" />
      <VisitorsSkeleton />
      <ListSkeleton title="Reviews" rows={3} />
    </main>
  );
}
