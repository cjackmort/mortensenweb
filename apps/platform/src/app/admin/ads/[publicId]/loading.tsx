import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Ad campaign" />
      <ListSkeleton title="Where it stands" rows={4} />
      <ListSkeleton title="The ad" rows={5} />
    </main>
  );
}
