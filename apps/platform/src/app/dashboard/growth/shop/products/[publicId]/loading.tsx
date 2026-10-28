import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Product" />
      <ListSkeleton title="On your website" rows={2} />
      <ListSkeleton title="Details" rows={3} />
    </main>
  );
}
