import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Availability" />
      <ListSkeleton title="Your weekly hours" rows={7} />
      <ListSkeleton title="How booking works" rows={3} />
    </main>
  );
}
