import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Connections" />
      <ListSkeleton title="Stripe" rows={2} />
      <ListSkeleton title="Google Search Console" rows={2} />
      <ListSkeleton title="Instagram" rows={2} />
    </main>
  );
}
