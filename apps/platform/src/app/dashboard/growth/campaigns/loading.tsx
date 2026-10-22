import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Campaigns" />
      <ListSkeleton title="Scans" rows={3} />
    </main>
  );
}
