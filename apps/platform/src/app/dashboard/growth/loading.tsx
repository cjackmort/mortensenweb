import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Growth" />
      <ListSkeleton title="Yours" rows={2} />
      <ListSkeleton title="Add more" rows={3} />
    </main>
  );
}
