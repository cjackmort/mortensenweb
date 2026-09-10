/**
 * Why is a request still saying "being worked on"?
 *
 * Read-only. Prints the state of every agent job that has not reached a
 * terminal status, alongside the request behind it, so the watchdog's decision
 * can be checked against the actual rows rather than guessed at.
 *
 * `expireStalledJobs` reclaims a job when **both** of these hold:
 *
 *     agent_jobs.status IN ('queued', 'dispatched', 'running')
 *     agent_jobs.timeout_at IS NOT NULL AND agent_jobs.timeout_at < now()
 *
 * so a row that is stuck is stuck for exactly one of three reasons: the status
 * is outside that set, `timeout_at` is null, or `timeout_at` is still in the
 * future. This says which.
 *
 * Deliberately prints no client content — no titles, no descriptions, no
 * names. Public ids and machine states only, because this output lands in a
 * CI log.
 */

interface Row {
  request_public_id: string;
  request_status: string;
  job_public_id: string | null;
  job_status: string | null;
  dispatched_at: string | null;
  timeout_at: string | null;
  finished_at: string | null;
  seconds_since_timeout: string | null;
}

export async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !/^postgres(ql)?:\/\//.test(url)) {
    console.error("DATABASE_URL is not a Postgres connection string.");
    process.exit(1);
  }

  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url);

  const rows = (await sql.query(
    `select
       cr.public_id                                as request_public_id,
       cr.status                                   as request_status,
       aj.public_id                                as job_public_id,
       aj.status                                   as job_status,
       aj.dispatched_at                            as dispatched_at,
       aj.timeout_at                               as timeout_at,
       aj.finished_at                              as finished_at,
       extract(epoch from (now() - aj.timeout_at))::text as seconds_since_timeout
     from change_requests cr
     left join lateral (
       select * from agent_jobs
       where agent_jobs.request_id = cr.id
       order by agent_jobs.created_at desc
       limit 1
     ) aj on true
     where cr.status not in ('verified', 'closed', 'rejected', 'rolled_back')
     order by cr.created_at desc
     limit 50`,
    [],
  )) as unknown as Row[];

  if (rows.length === 0) {
    console.log("No open requests.");
    return;
  }

  console.log(`${rows.length} open request(s).\n`);

  const RECLAIMABLE = new Set(["queued", "dispatched", "running"]);
  let stuck = 0;

  for (const row of rows) {
    console.log(`request ${row.request_public_id}  status=${row.request_status}`);

    if (!row.job_public_id) {
      console.log("  no agent job — nothing has been dispatched\n");
      continue;
    }

    console.log(
      `  job ${row.job_public_id}  status=${row.job_status}\n` +
        `    dispatched_at = ${row.dispatched_at ?? "null"}\n` +
        `    timeout_at    = ${row.timeout_at ?? "null"}\n` +
        `    finished_at   = ${row.finished_at ?? "null"}`,
    );

    // The watchdog's own condition, spelled out per row.
    const statusOk = RECLAIMABLE.has(row.job_status ?? "");
    const overdue =
      row.seconds_since_timeout !== null &&
      Number(row.seconds_since_timeout) > 0;

    if (!statusOk && RECLAIMABLE.has(row.request_status)) {
      stuck += 1;
      console.log(
        `    STUCK: the job finished as "${row.job_status}" but the request` +
          ` was left at "${row.request_status}" — the watchdog updated the job` +
          ` and did not reach the request.`,
      );
    } else if (statusOk && row.timeout_at === null) {
      stuck += 1;
      console.log(
        "    STUCK: timeout_at is null, so the watchdog's" +
          " `timeout_at IS NOT NULL` test can never match this row.",
      );
    } else if (statusOk && overdue) {
      stuck += 1;
      const minutes = Math.round(Number(row.seconds_since_timeout) / 60);
      console.log(
        `    STUCK: overdue by ${minutes} min and still not reclaimed —` +
          " the row matches the watchdog's query, so the job is throwing.",
      );
    } else if (statusOk) {
      console.log("    running, not yet due");
    }

    console.log("");
  }

  console.log(stuck === 0 ? "Nothing stuck." : `${stuck} stuck.`);
}

main().catch((error) => {
  console.error("Diagnosis failed:", error);
  process.exit(1);
});
