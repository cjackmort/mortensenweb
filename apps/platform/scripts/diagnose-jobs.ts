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

  // Which database this actually is.
  //
  // The previous run reported every change request as closed while the portal
  // had one open on screen. That is not a disagreement about state, it is a
  // disagreement about *which database* — and the only way to tell is to make
  // each connection identify itself. Names and row counts only; nothing here
  // is a credential and nothing here is client content.
  const identity = (await sql.query(
    `select current_database() as db,
            current_user       as usr,
            version()          as version`,
    [],
  )) as unknown as { db: string; usr: string; version: string }[];

  const id = identity[0];
  console.log(`database = ${id?.db}`);
  console.log(`user     = ${id?.usr}`);
  console.log(`postgres = ${(id?.version ?? "").split(" ").slice(0, 2).join(" ")}`);

  const counts = (await sql.query(
    `select 'organizations' as t, count(*)::text as n from organizations
     union all select 'clients',        count(*)::text from clients
     union all select 'sites',          count(*)::text from sites
     union all select 'change_requests',count(*)::text from change_requests
     union all select 'agent_jobs',     count(*)::text from agent_jobs
     union all select 'media_assets',   count(*)::text from media_assets
     union all select 'migrations',     count(*)::text from drizzle.__drizzle_migrations`,
    [],
  )) as unknown as { t: string; n: string }[];

  console.log("\nrow counts");
  for (const row of counts) console.log(`  ${row.t.padEnd(18)} ${row.n}`);
  console.log("");

  // Which repository each site is wired to, and whether the agent can act on
  // it. A live client whose repository holds no caller workflow will have the
  // portal open an issue that nothing ever answers: the request goes to
  // `dispatched`, no run starts, and it sits there until the watchdog fails it.
  // Nothing on screen distinguishes that from a run in progress.
  //
  // Repository coordinates and the site's own public domain only — both are
  // infrastructure rather than client information.
  const repos = (await sql.query(
    `select s.public_id                as site_public_id,
            coalesce(s.primary_domain, '(none)') as domain,
            s.status::text             as site_status,
            rc.owner                   as owner,
            rc.name                    as name,
            rc.default_branch          as branch,
            (rc.installation_id is not null)::text as installed,
            c.is_internal::text        as internal
       from sites s
       left join repository_connections rc on rc.site_id = s.id
       left join clients c on c.organization_id = s.organization_id
      order by c.is_internal, s.created_at`,
    [],
  )) as unknown as {
    site_public_id: string;
    domain: string;
    site_status: string;
    owner: string | null;
    name: string | null;
    branch: string | null;
    installed: string | null;
    internal: string | null;
  }[];

  console.log("sites and their repositories");
  for (const r of repos) {
    const repo = r.owner && r.name ? `${r.owner}/${r.name}@${r.branch}` : "(no repository connected)";
    const flags = [
      r.internal === "true" ? "internal" : null,
      r.installed === "true" ? null : "NO APP INSTALL",
    ].filter(Boolean);
    console.log(
      `  ${r.domain.padEnd(34)} ${r.site_status.padEnd(10)} ${repo}` +
        (flags.length ? `  [${flags.join(", ")}]` : ""),
    );
  }
  console.log("");

  // The media library's own state.
  //
  // An upload writes rows in a fixed order: the asset and the session first,
  // then one blob per part with a row recording it, then the assembled
  // original. Where it stops says which step is failing — and in particular,
  // whether a single part has *ever* been stored. Zero parts against many
  // upload sessions means the object store write fails every time rather than
  // failing on size or on a particular file.
  const media = (await sql.query(
    `select
       (select count(*)::text from media_assets)                       as assets,
       (select count(*)::text from media_assets where status = 'ready') as ready,
       (select count(*)::text from media_assets where status = 'uploading') as uploading,
       (select count(*)::text from media_assets where status = 'processing') as processing,
       (select count(*)::text from media_assets where status = 'failed')     as failed,
       (select count(*)::text from media_uploads)                      as sessions,
       (select count(*)::text from media_upload_parts)                 as parts,
       (select count(*)::text from media_derivatives)                  as derivatives,
       (select coalesce(max(byte_size), 0)::text from media_assets)    as largest,
       (select count(*)::text from media_assets where storage_key is not null) as with_key`,
    [],
  )) as unknown as Record<string, string>[];

  const m = media[0]!;
  console.log("media library");
  console.log(`  assets            ${m.assets}  (ready ${m.ready}, uploading ${m.uploading}, processing ${m.processing}, failed ${m.failed})`);
  console.log(`  upload sessions   ${m.sessions}`);
  console.log(`  parts stored      ${m.parts}`);
  console.log(`  derivatives       ${m.derivatives}`);
  console.log(`  assets with a storage key ${m.with_key}`);
  console.log(`  largest byte_size ${(Number(m.largest) / 1024 / 1024).toFixed(1)} MB`);

  if (Number(m.sessions) > 0 && Number(m.parts) === 0) {
    console.log(
      "\n  DIAGNOSIS: sessions were created and not one part was ever stored." +
        "\n  The part route writes the blob before it writes the row, so the" +
        "\n  object store write is failing on every call — not on size, and not" +
        "\n  on a particular file.",
    );
  } else if (Number(m.parts) > 0 && Number(m.ready) === 0) {
    console.log(
      "\n  DIAGNOSIS: parts are being stored but nothing reaches `ready`," +
        "\n  so the failure is in assembling the original, not in the upload.",
    );
  }
  // Why, in the storage layer's own words. Empty until a failure is recorded,
  // which for the assets stuck from before this was added it will be.
  const reasons = (await sql.query(
    `select coalesce(failure_reason, '(none recorded)') as reason,
            count(*)::text as n
       from media_assets
      where status in ('failed', 'uploading')
      group by failure_reason
      order by count(*) desc
      limit 10`,
    [],
  )) as unknown as { reason: string; n: string }[];

  if (reasons.length > 0) {
    console.log("  failure reasons on assets that did not finish");
    for (const r of reasons) console.log(`    ${r.n} x  ${r.reason}`);
  }

  console.log("");

  // Always printed, and printed first, because "no open requests" is an
  // answer that can mean two very different things: there genuinely are none,
  // or this is not the database the portal is reading. A histogram of every
  // row in the table distinguishes them immediately, and the last run of this
  // script could not.
  const histogram = (await sql.query(
    `select status::text as status, count(*)::text as count
       from change_requests group by status order by count(*) desc`,
    [],
  )) as unknown as { status: string; count: string }[];

  const total = histogram.reduce((sum, r) => sum + Number(r.count), 0);
  console.log(`change_requests: ${total} row(s) in total`);
  for (const row of histogram) {
    console.log(`  ${row.status.padEnd(20)} ${row.count}`);
  }
  console.log("");

  if (rows.length === 0) {
    console.log(
      total === 0
        ? "The table is empty — this is not the database the portal is using."
        : "No open requests: every row is verified, closed, rejected or rolled back.",
    );
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
