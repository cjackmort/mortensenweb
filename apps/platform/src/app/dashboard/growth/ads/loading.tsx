import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Ads" />
      <ListSkeleton title="Ads on Google, Facebook and Instagram" rows={4} />
      <ListSkeleton title="Your campaigns" rows={3} />
    </main>
  );
}
