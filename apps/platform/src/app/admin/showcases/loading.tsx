import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Showcases" />
      <ListSkeleton title="Jobs" rows={4} />
    </main>
  );
}
