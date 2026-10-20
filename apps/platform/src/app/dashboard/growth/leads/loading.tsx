import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Leads" />
      <ListSkeleton title="Inbox" rows={4} />
    </main>
  );
}
