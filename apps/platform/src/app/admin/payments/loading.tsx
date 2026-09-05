import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

/**
 * Shown the instant this route is requested, replaced when the page streams in.
 * See `components/skeletons.tsx` for why the shapes match the real panels.
 */
export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Payments" />
      <ListSkeleton title="Subscriptions" rows={4} />
      <ListSkeleton title="Revenue" rows={3} />
    </main>
  );
}
