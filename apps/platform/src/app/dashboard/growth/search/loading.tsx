import { ListSkeleton, MastheadSkeleton, VisitorsSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Search" />
      <VisitorsSkeleton />
      <ListSkeleton title="What people searched" rows={5} />
    </main>
  );
}
