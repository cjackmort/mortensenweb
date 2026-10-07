import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import { currentMonth, ledgerEntries, yearRange } from "@/db/repositories/admin/finance";
import { ledgerCsv } from "@/lib/finance/ledger-csv";

/**
 * The ledger for one calendar year, as a CSV for the accountant.
 *
 * Behind the admin session like every other `/admin` path; `proxy.ts` sends
 * an anonymous request to the login page before it gets here. The role is
 * still checked, because a signed-in client is a session too, and anything
 * but an admin gets the same 404 as a path that does not exist.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const user = await currentUser();
  if (!user || user.role !== "admin") return new Response("Not found", { status: 404 });

  const requested = new URL(request.url).searchParams.get("year") ?? "";
  const year = /^\d{4}$/.test(requested) ? Number(requested) : Number(currentMonth().slice(0, 4));

  const db = await getDb();
  const entries = await ledgerEntries(adminContextFrom(user), db, yearRange(year));

  return new Response(ledgerCsv(entries), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="mortensenweb-ledger-${year}.csv"`,
      // A year of the agency's income by client is not something a shared
      // cache or the browser's back button should keep.
      "cache-control": "no-store",
    },
  });
}
