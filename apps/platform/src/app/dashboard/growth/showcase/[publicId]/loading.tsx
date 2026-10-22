import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Job showcase" />
      <ListSkeleton title="Website page" rows={1} />
      <ListSkeleton title="Social graphics" rows={2} />
      <ListSkeleton title="Google post" rows={2} />
    </main>
  );
}
