import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Welcome" />
      <ListSkeleton title="Your website" rows={2} />
      <ListSkeleton title="Add a care plan" rows={4} />
    </main>
  );
}
