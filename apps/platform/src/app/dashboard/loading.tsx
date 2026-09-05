import { ListSkeleton, MastheadSkeleton, VisitorsSkeleton } from "@/components/skeletons";

/**
 * Shown the instant this route is requested, replaced when the page streams in.
 * See `components/skeletons.tsx` for why the shapes match the real panels.
 */
export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Your website" />
      <VisitorsSkeleton />
      <ListSkeleton title="Recent requests" rows={2} />
    </main>
  );
}
