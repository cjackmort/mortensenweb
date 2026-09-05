import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

/**
 * Shown the instant this route is requested, replaced when the page streams in.
 * See `components/skeletons.tsx` for why the shapes match the real panels.
 */
export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Billing" />
      <ListSkeleton title="Your plan" rows={3} />
      <ListSkeleton title="Payments" rows={3} />
    </main>
  );
}
