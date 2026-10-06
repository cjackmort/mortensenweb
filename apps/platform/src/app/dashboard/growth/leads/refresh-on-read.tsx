"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Opening an unread lead marks it read on the server, but the unread count on
 * the Growth tab lives in the shared layout, which a client-side navigation
 * does not re-render — so the badge kept counting a lead the client was
 * looking at. One refresh after the page lands brings the layout up to date.
 * Only for a lead that *was* unread, so reading old ones costs nothing.
 */
export function RefreshOnRead({ wasUnread }: { wasUnread: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (wasUnread) router.refresh();
  }, [wasUnread, router]);
  return null;
}
