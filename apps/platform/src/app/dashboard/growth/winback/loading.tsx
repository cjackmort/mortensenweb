import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Win-back emails" />
      <ListSkeleton title="Your past customers" rows={1} />
      <ListSkeleton title="Your emails" rows={3} />
    </main>
  );
}
