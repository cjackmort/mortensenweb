import { connectClientRepository } from "@/lib/operator-api/client-repository";
import { handleOperatorRequest, publicIdParam, readJsonBody } from "@/lib/operator-api/http";
import { connectRepositoryBody } from "@/lib/operator-api/schemas";

/**
 * `POST /api/operator/clients/:id/repository` connects a repository that
 * already exists to the client's site, as admin → Website → "Connect a
 * repository" does. For a client whose site was built before the portal, in its
 * own repository.
 *
 * Authenticated by the operator API token (see `lib/operator-api/http.ts`).
 * It records the connection and nothing more: allowing automated work and
 * installing the workflows and tokens are the conversion's steps. Repeating it
 * refreshes the connection rather than adding another. Held to
 * `CONNECTIONS_PER_HOUR`, counted from the audit log.
 */

export const dynamic = "force-dynamic";
// A GitHub read, up to two Netlify lookups and a handful of writes.
export const maxDuration = 30;

const CONNECTIONS_PER_HOUR = 30;
const HOUR_MS = 60 * 60_000;

type Params = { params: Promise<{ publicId: string }> };

export async function POST(request: Request, { params }: Params): Promise<Response> {
  return handleOperatorRequest(
    request,
    {
      action: "clients.repository.connect",
      quota: { auditAction: "repository.connected", limit: CONNECTIONS_PER_HOUR, windowMs: HOUR_MS },
    },
    async ({ ctx, db }) => {
      const clientId = publicIdParam((await params).publicId);
      const body = await readJsonBody(request, connectRepositoryBody);

      const connected = await connectClientRepository(ctx, db, clientId, body);
      return { status: 200, body: { ...connected }, entity: { type: "client", id: clientId } };
    },
  );
}
