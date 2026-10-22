import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Show off a job" />
      <ListSkeleton title="1. Photos of the job" rows={2} />
      <ListSkeleton title="2. A few words" rows={3} />
    </main>
  );
}
