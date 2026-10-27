import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Your profile" />
      <ListSkeleton title="You" rows={2} />
      <ListSkeleton title="Your business" rows={4} />
    </main>
  );
}
