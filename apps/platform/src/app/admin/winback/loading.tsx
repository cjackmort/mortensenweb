import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Win-back emails" />
      <ListSkeleton title="Campaigns" rows={4} />
    </main>
  );
}
