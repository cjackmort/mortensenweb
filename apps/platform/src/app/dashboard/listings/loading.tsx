import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Get listed" />
      <ListSkeleton title="Your website" rows={8} />
    </main>
  );
}
