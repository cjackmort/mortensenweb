import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

/** Shown while the Google page reads the connection and the queue. */
export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Google profiles" />
      <ListSkeleton title="Google connection" rows={2} />
      <ListSkeleton title="To do" rows={4} />
    </main>
  );
}
