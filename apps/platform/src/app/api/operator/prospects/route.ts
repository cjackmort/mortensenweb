import { handleOperatorRequest, readJsonBody } from "@/lib/operator-api/http";
import { createProspectWithConcept } from "@/lib/operator-api/prospects";
import { createProspectBody } from "@/lib/operator-api/schemas";

/**
 * `POST /api/operator/prospects` — a potential client and its concept site.
 *
 * Authenticated by the operator API token (see `lib/operator-api/http.ts`).
 * Each call creates a private repository and a Netlify site, so on top of the
 * per-minute limit it is held to `PROSPECTS_PER_HOUR`, counted from the audit
 * log so a restart does not reset it.
 */

export const dynamic = "force-dynamic";
// Generating a repository, sealing its secrets and creating a Netlify site are
// a dozen network calls; the default ten seconds is not enough for them.
export const maxDuration = 60;

const PROSPECTS_PER_HOUR = 10;
const HOUR_MS = 60 * 60_000;

export async function POST(request: Request): Promise<Response> {
  return handleOperatorRequest(
    request,
    {
      action: "prospects.create",
      quota: { auditAction: "prospect.created", limit: PROSPECTS_PER_HOUR, windowMs: HOUR_MS },
    },
    async ({ ctx, db }) => {
      const body = await readJsonBody(request, createProspectBody);
      const created = await createProspectWithConcept(ctx, db, body);
      return {
        status: 201,
        body: { ...created },
        entity: { type: "prospect", id: created.prospectId },
      };
    },
  );
}
