import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Job showcase" />
      <ListSkeleton title="Your jobs" rows={3} />
    </main>
  );
}
