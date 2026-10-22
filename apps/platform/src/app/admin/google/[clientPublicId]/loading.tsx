import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

/** Shown while one client's Google workspace loads. */
export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Google profile" />
      <ListSkeleton title="Profile" rows={2} />
      <ListSkeleton title="Reviews" rows={3} />
    </main>
  );
}
