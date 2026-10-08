import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Your plan" />
      <ListSkeleton title="Your plan" rows={3} />
      <ListSkeleton title="Change plan" rows={2} />
    </main>
  );
}
