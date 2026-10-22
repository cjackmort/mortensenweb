import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Reports" />
      <ListSkeleton title="Your reports" rows={3} />
    </main>
  );
}
