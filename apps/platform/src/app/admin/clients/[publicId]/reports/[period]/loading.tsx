import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Report preview" />
      <ListSkeleton title="Before you send" rows={3} />
      <ListSkeleton title="At a glance" rows={5} />
    </main>
  );
}
