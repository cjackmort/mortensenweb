import Link from "next/link";
import type { listArchivedClients } from "@/db/repositories/admin/clients";
import { restoreClientAction } from "./remove-actions";
import { FocusedNotice } from "./focused-notice";

type ArchivedClient = Awaited<ReturnType<typeof listArchivedClients>>[number];

/**
 * Clients taken off the list, with a way back.
 *
 * Collapsed by default: this is the undo drawer, not something to read every
 * visit. Nothing about a client is lost on removal — payments, plan, site and
 * history are all still there — so "Restore" is a flag flip, not a rebuild.
 */
export function ArchivedClientsSection({ archived }: { archived: ArchivedClient[] }) {
  if (archived.length === 0) return null;

  return (
    <section className="card archived-clients">
      <details>
        <summary>
          <h2>
            Archived clients <span className="muted">({archived.length})</span>
          </h2>
        </summary>

        <p className="muted" style={{ marginTop: 0 }}>
          Removed from Clients and the billing totals. Their payments, plan and
          site are untouched.
        </p>

        <ul className="archived-client-list">
          {archived.map((client) => (
            <li key={client.clientPublicId}>
              <div>
                <Link href={`/admin/clients/${client.clientPublicId}`} className="linklike">
                  {client.name}
                </Link>
                {client.archivedAt && (
                  <span className="muted">
                    {" "}
                    · removed {client.archivedAt.toLocaleDateString("en-US")}
                  </span>
                )}
              </div>
              <RestoreForm clientPublicId={client.clientPublicId} clientName={client.name} />
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

/** The undo shown straight after a removal, and given focus when it appears. */
export function RemovedNotice({
  clientPublicId,
  clientName,
}: {
  clientPublicId: string;
  clientName: string;
}) {
  return (
    <FocusedNotice>
      <strong>{clientName}</strong> was removed from Clients. Their payments, site and
      history are untouched.{" "}
      <RestoreForm clientPublicId={clientPublicId} clientName={clientName} inline />
    </FocusedNotice>
  );
}

export function RestoreForm({
  clientPublicId,
  clientName,
  inline = false,
}: {
  clientPublicId: string;
  clientName: string;
  inline?: boolean;
}) {
  return (
    <form action={restoreClientAction} style={inline ? { display: "inline" } : undefined}>
      <input type="hidden" name="clientPublicId" value={clientPublicId} />
      <button
        type="submit"
        className={inline ? "linklike" : "secondary small"}
        aria-label={`Restore ${clientName}`}
      >
        Restore
      </button>
    </form>
  );
}
