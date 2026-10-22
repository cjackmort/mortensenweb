import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Review requests" />
      <ListSkeleton title="Your Google review link" rows={1} />
      <ListSkeleton title="The message" rows={3} />
    </main>
  );
}
