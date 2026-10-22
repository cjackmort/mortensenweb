import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Past customers" />
      <ListSkeleton title="Add customers" rows={2} />
      <ListSkeleton title="Everyone on your list" rows={5} />
    </main>
  );
}
