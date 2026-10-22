import { count, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "@/db/client";
import { agentJobs, changeRequests, clients, organizations, showcasePhotos, showcases } from "@/db/schema";
import { googleOutput, siteOutput, type GoogleOutput, type SiteOutput } from "@/lib/showcase/status";
import type { AdminContext } from "../context";

/**
 * Every client's showcases, for the operator.
 *
 * Read-only. The site page is an ordinary change request, so dispatching,
 * releasing and merging it happen in the Requests queue like any other; this
 * list is for seeing which jobs are stuck before a client asks — a page
 * waiting on an open change, a month's changes used up, a Google post still
 * waiting to be pasted.
 */

export interface AdminShowcaseRow {
  publicId: string;
  title: string;
  town: string;
  status: "draft" | "approved";
  createdAt: Date;
  organizationName: string;
  clientPublicId: string | null;
  requestTitle: string | null;
  photoCount: number;
  site: SiteOutput;
  google: GoogleOutput;
}

export async function listAllShowcases(
  _ctx: AdminContext,
  db: Database,
  { limit = 100 }: { limit?: number } = {},
): Promise<AdminShowcaseRow[]> {
  const rows = await db
    .select({
      id: showcases.id,
      publicId: showcases.publicId,
      title: showcases.title,
      town: showcases.town,
      status: showcases.status,
      createdAt: showcases.createdAt,
      siteBlockedReason: showcases.siteBlockedReason,
      googleStatus: showcases.googleStatus,
      organizationName: organizations.name,
      clientPublicId: clients.publicId,
      requestId: changeRequests.id,
      requestTitle: changeRequests.title,
      requestStatus: changeRequests.status,
    })
    .from(showcases)
    .innerJoin(organizations, eq(organizations.id, showcases.organizationId))
    .leftJoin(clients, eq(clients.organizationId, showcases.organizationId))
    .leftJoin(changeRequests, eq(changeRequests.id, showcases.siteRequestId))
    .orderBy(desc(showcases.createdAt))
    .limit(limit);

  const ids = rows.map((r) => r.id);
  const requestIds = rows.map((r) => r.requestId).filter((id): id is string => id !== null);

  const photoCounts = ids.length
    ? await db
        .select({ showcaseId: showcasePhotos.showcaseId, n: count() })
        .from(showcasePhotos)
        .where(inArray(showcasePhotos.showcaseId, ids))
        .groupBy(showcasePhotos.showcaseId)
    : [];

  const jobs = requestIds.length
    ? await db
        .select({
          requestId: agentJobs.requestId,
          operatorReleasedAt: agentJobs.operatorReleasedAt,
          previewVerifiedAt: agentJobs.previewVerifiedAt,
        })
        .from(agentJobs)
        .where(inArray(agentJobs.requestId, requestIds))
        .orderBy(desc(agentJobs.createdAt))
    : [];
  const latestJob = new Map<string, (typeof jobs)[number]>();
  for (const job of jobs) {
    if (job.requestId && !latestJob.has(job.requestId)) latestJob.set(job.requestId, job);
  }

  return rows.map((row) => {
    const job = row.requestId ? latestJob.get(row.requestId) : undefined;
    return {
      publicId: row.publicId,
      title: row.title,
      town: row.town,
      status: row.status === "approved" ? "approved" : "draft",
      createdAt: row.createdAt,
      organizationName: row.organizationName,
      clientPublicId: row.clientPublicId,
      requestTitle: row.requestTitle,
      photoCount: photoCounts.find((p) => p.showcaseId === row.id)?.n ?? 0,
      site: siteOutput({
        approved: row.status === "approved",
        blockedReason: row.siteBlockedReason,
        request: row.requestStatus
          ? {
              status: row.requestStatus,
              previewReleased: Boolean(job?.operatorReleasedAt && job.previewVerifiedAt),
            }
          : null,
      }),
      google: googleOutput(row.googleStatus),
    };
  });
}
