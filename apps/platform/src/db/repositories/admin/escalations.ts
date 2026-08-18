import { and, desc, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  agentJobs,
  changeRequests,
  organizations,
  repositoryConnections,
  requestEvents,
  sites,
} from "@/db/schema";
import type { AdminContext } from "../context";

/**
 * The requests waiting on a person.
 *
 * What an operator needs here is not a status — the table already shows that —
 * but everything required to start working without going and looking it up:
 * which repository, which issue, and what the agent said stopped it. A queue
 * that makes you assemble that yourself is a queue that gets ignored.
 *
 * `AdminContext` rather than `TenantContext`: this deliberately spans every
 * client, which is why it lives in the admin directory and cannot be reached
 * from a client route.
 */
export interface Escalation {
  requestPublicId: string;
  title: string;
  description: string | null;
  organizationName: string;
  createdAt: Date;
  /** The agent's own words about what blocked it. Null if it gave none. */
  reason: string | null;
  repo: string | null;
  issueNumber: number | null;
  prNumber: number | null;
}

export async function listEscalations(
  _ctx: AdminContext,
  db: Database,
  { limit = 25 }: { limit?: number } = {},
): Promise<Escalation[]> {
  const rows = await db
    .select({
      id: changeRequests.id,
      requestPublicId: changeRequests.publicId,
      title: changeRequests.title,
      description: changeRequests.description,
      createdAt: changeRequests.createdAt,
      organizationName: organizations.name,
      owner: repositoryConnections.owner,
      name: repositoryConnections.name,
      issueNumber: agentJobs.issueNumber,
      prNumber: agentJobs.prNumber,
    })
    .from(changeRequests)
    .innerJoin(organizations, eq(organizations.id, changeRequests.organizationId))
    .leftJoin(agentJobs, eq(agentJobs.requestId, changeRequests.id))
    .leftJoin(sites, eq(sites.id, changeRequests.siteId))
    .leftJoin(
      repositoryConnections,
      eq(repositoryConnections.siteId, sites.id),
    )
    .where(eq(changeRequests.status, "needs_operator"))
    .orderBy(desc(changeRequests.createdAt))
    .limit(limit);

  // The reason is read per request rather than joined: a request can be
  // escalated more than once across re-dispatches, and a join would multiply
  // the rows rather than pick the latest.
  return Promise.all(
    rows.map(async (row) => {
      const events = await db
        .select({ body: requestEvents.body })
        .from(requestEvents)
        .where(
          and(
            eq(requestEvents.requestId, row.id),
            eq(requestEvents.kind, "escalated"),
          ),
        )
        .orderBy(desc(requestEvents.createdAt))
        .limit(1);

      return {
        requestPublicId: row.requestPublicId,
        title: row.title,
        description: row.description,
        organizationName: row.organizationName,
        createdAt: row.createdAt,
        reason: events[0]?.body ?? null,
        repo: row.owner && row.name ? `${row.owner}/${row.name}` : null,
        issueNumber: row.issueNumber,
        prNumber: row.prNumber,
      };
    }),
  );
}
