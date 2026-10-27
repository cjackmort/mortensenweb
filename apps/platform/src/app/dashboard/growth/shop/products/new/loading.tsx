import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Add a product" />
      <ListSkeleton title="1. Details" rows={3} />
      <ListSkeleton title="2. Photos" rows={2} />
    </main>
  );
}
