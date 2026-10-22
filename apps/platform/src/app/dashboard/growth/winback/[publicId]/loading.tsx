import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Win-back email" />
      <ListSkeleton title="The email" rows={4} />
    </main>
  );
}
