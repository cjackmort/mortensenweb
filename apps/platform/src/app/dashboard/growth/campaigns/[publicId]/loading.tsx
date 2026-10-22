import { ListSkeleton, MastheadSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <main className="shell">
      <MastheadSkeleton title="Campaign" />
      <ListSkeleton title="Your QR code" rows={3} />
    </main>
  );
}
