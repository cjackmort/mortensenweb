import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Ads" />
      <ListSkeleton title="Connections" rows={2} />
      <ListSkeleton title="Waiting for review" rows={3} />
    </main>
  );
}
