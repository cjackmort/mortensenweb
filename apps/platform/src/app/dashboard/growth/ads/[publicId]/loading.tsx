import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Your ad" />
      <ListSkeleton title="Where it stands" rows={2} />
      <ListSkeleton title="The ad" rows={5} />
    </main>
  );
}
