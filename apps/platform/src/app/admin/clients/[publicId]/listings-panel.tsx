import { ListingChecklist } from "@/components/listing-checklist";
import { ListingProgressLine } from "@/components/listing-progress";
import type { SiteChecklist } from "@/lib/listings/checklist";
import { markListingStepForClientAction } from "./listing-actions";

/**
 * One site's Get listed checklist, on the operator's side. The same list the
 * client sees at /dashboard/listings, drawn by the same component; only the
 * action differs, and it names the client so the site is resolved through
 * them.
 */
export function ListingsPanel({
  clientPublicId,
  checklist,
  viewerUserId,
}: {
  clientPublicId: string;
  checklist: SiteChecklist;
  viewerUserId: string;
}) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Get listed</h2>
        <span className="muted">{checklist.progress.label}</span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        The directories this site has to be in. The client sees the same list and can tick what they
        did themselves; what you tick here shows to them as done by Mortensen Web.
      </p>
      <ListingProgressLine progress={checklist.progress} />
      <ListingChecklist
        checklist={checklist}
        action={markListingStepForClientAction}
        hidden={{ clientPublicId }}
        readOnly={false}
        viewerUserId={viewerUserId}
      />
    </section>
  );
}
