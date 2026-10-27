import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Shop" />
      <ListSkeleton title="Getting set up" rows={3} />
    </main>
  );
}
