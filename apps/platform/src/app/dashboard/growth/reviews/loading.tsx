import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Review requests" />
      <ListSkeleton title="Ask for a review" rows={2} />
      <ListSkeleton title="How it's going" rows={4} />
    </main>
  );
}
