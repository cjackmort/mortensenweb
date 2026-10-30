import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Get started" />
      <ListSkeleton title="Needed to get running" rows={3} />
      <ListSkeleton title="When you're ready" rows={4} />
    </main>
  );
}
