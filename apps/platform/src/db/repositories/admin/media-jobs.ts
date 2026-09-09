import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { mediaAssets, mediaDerivatives, mediaJobs } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { deriveAll } from "@/lib/media/derivatives";
import { derivativeKey, mediaDriver } from "@/lib/storage/driver";

/**
 * Turning an uploaded original into the sizes a website uses.
 *
 * This is a queue rather than work done inline, for a reason the old attachment
 * path demonstrated: resizing five sizes of a 40 MB image does not fit in the
 * budget of a request a person is waiting on, and putting it there is how a
 * submit action times out and the client loses everything they typed.
 *
 * ## What makes it durable
 *
 *  - **A claim is a conditional UPDATE.** Two runners racing for one job means
 *    one `UPDATE ... WHERE status = 'queued'` returns a row and the other
 *    returns none. There is no read-then-write window to lose.
 *  - **A crash is recoverable.** A runner that dies leaves `status = 'running'`
 *    with a `locked_at` that then goes stale. The claimer takes those back
 *    after `STALE_LOCK_MINUTES`, so a killed function does not strand an asset
 *    at `processing` forever.
 *  - **Retries are bounded and visible.** `max_attempts` is 3 with growing
 *    backoff. On the last failure the asset is marked `failed` with a reason
 *    the client can read — never left spinning. A job that cannot succeed must
 *    say so, because "processing" that never ends is indistinguishable from a
 *    system that is broken.
 */

const STALE_LOCK_MINUTES = 15;
const BACKOFF_MINUTES = [1, 5, 15];

export interface JobOutcome {
  assetPublicId: string;
  ok: boolean;
  derivatives: number;
  message?: string;
}

/** Queue derivative work. Idempotent against the one-open-job-per-asset index. */
export async function enqueueDerivatives(
  db: Database,
  assetId: string,
): Promise<void> {
  await db
    .insert(mediaJobs)
    .values({ publicId: newPublicId(), assetId })
    .onConflictDoNothing();
}

/**
 * Take one job, or nothing.
 *
 * The `WHERE` does all the work: a job is claimable when it is queued and due,
 * or when it is running with a lock old enough to be a dead runner. Selecting
 * candidates first and updating second would let two runners select the same
 * row before either wrote.
 */
async function claimJob(db: Database): Promise<{ id: string; assetId: string; attempts: number } | null> {
  const staleBefore = new Date(Date.now() - STALE_LOCK_MINUTES * 60_000);

  const claimed = await db
    .update(mediaJobs)
    .set({ status: "running", lockedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        sql`${mediaJobs.id} = (
          SELECT j."id" FROM "media_jobs" j
          WHERE (j."status" = 'queued' AND j."next_attempt_at" <= now())
             OR (j."status" = 'running' AND j."locked_at" < ${staleBefore})
          ORDER BY j."next_attempt_at" ASC
          LIMIT 1
        )`,
        or(
          eq(mediaJobs.status, "queued"),
          and(eq(mediaJobs.status, "running"), lte(mediaJobs.lockedAt, staleBefore)),
        )!,
      ),
    )
    .returning({
      id: mediaJobs.id,
      assetId: mediaJobs.assetId,
      attempts: mediaJobs.attempts,
    });

  return claimed[0] ?? null;
}

/**
 * Run queued derivative jobs, up to `limit`.
 *
 * Bounded per invocation because this shares the scheduled tick with everything
 * else. A backlog drains over several ticks rather than one run consuming the
 * whole function budget and being killed halfway.
 */
export async function runDerivativeJobs(
  db: Database,
  limit = 3,
): Promise<JobOutcome[]> {
  const outcomes: JobOutcome[] = [];

  for (let i = 0; i < limit; i += 1) {
    const job = await claimJob(db);
    if (!job) break;
    outcomes.push(await runOne(db, job));
  }

  return outcomes;
}

async function runOne(
  db: Database,
  job: { id: string; assetId: string; attempts: number },
): Promise<JobOutcome> {
  const attempt = job.attempts + 1;

  const assetRows = await db
    .select({
      publicId: mediaAssets.publicId,
      storageKey: mediaAssets.storageKey,
      status: mediaAssets.status,
    })
    .from(mediaAssets)
    .where(eq(mediaAssets.id, job.assetId))
    .limit(1);

  const asset = assetRows[0];

  if (!asset || !asset.storageKey) {
    // The asset went away, or never got its bytes. Nothing to retry towards.
    await db
      .update(mediaJobs)
      .set({
        status: "cancelled",
        attempts: attempt,
        lastError: "The image is no longer available.",
        lockedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(mediaJobs.id, job.id));
    return {
      assetPublicId: asset?.publicId ?? "unknown",
      ok: false,
      derivatives: 0,
      message: "asset missing",
    };
  }

  try {
    const driver = mediaDriver();
    const object = await driver.get(asset.storageKey);
    if (!object) throw new Error("The original could not be read from storage.");

    const run = await deriveAll(object.bytes);

    if (run.outputs.length === 0) {
      throw new Error(
        run.failures[0]?.message ?? "No sizes could be generated from this image.",
      );
    }

    // Objects first, then rows — the same ordering rule as the upload path, so
    // an interruption leaves an orphan object rather than a row pointing at
    // bytes that are not there.
    for (const output of run.outputs) {
      const key = derivativeKey(asset.publicId, output.kind, output.extension);
      await driver.put({ key, bytes: output.bytes, contentType: output.contentType });

      await db
        .insert(mediaDerivatives)
        .values({
          assetId: job.assetId,
          kind: output.kind,
          storageKey: key,
          contentType: output.contentType,
          width: output.width,
          height: output.height,
          byteSize: output.bytes.byteLength,
        })
        .onConflictDoUpdate({
          target: [mediaDerivatives.assetId, mediaDerivatives.kind],
          set: {
            storageKey: key,
            contentType: output.contentType,
            width: output.width,
            height: output.height,
            byteSize: output.bytes.byteLength,
            createdAt: new Date(),
          },
        });
    }

    // Ready at last, and only now: the thumbnail exists, so the library can
    // show this image and a request can carry it.
    //
    // A partial set still counts as ready. Every size is generated from the
    // original on demand if it is ever needed again, and withholding an image
    // from a client because one of five sizes failed helps nobody.
    await db
      .update(mediaAssets)
      .set({
        status: "ready",
        failureReason:
          run.failures.length > 0
            ? `Some sizes could not be generated: ${run.failures.map((f) => f.kind).join(", ")}.`
            : null,
        updatedAt: new Date(),
      })
      .where(eq(mediaAssets.id, job.assetId));

    await db
      .update(mediaJobs)
      .set({
        status: "succeeded",
        attempts: attempt,
        lastError: null,
        lockedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(mediaJobs.id, job.id));

    return { assetPublicId: asset.publicId, ok: true, derivatives: run.outputs.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const exhausted = attempt >= 3;

    if (exhausted) {
      // Out of attempts. The asset is marked failed with something the client
      // can act on, and the retry control in the library re-queues it.
      await db
        .update(mediaJobs)
        .set({
          status: "failed",
          attempts: attempt,
          lastError: message,
          lockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(mediaJobs.id, job.id));

      await db
        .update(mediaAssets)
        .set({
          status: "failed",
          failureReason:
            "We could not prepare this image for use on your site. You can retry it, or send it to us and we will look.",
          updatedAt: new Date(),
        })
        .where(eq(mediaAssets.id, job.assetId));

      return { assetPublicId: asset.publicId, ok: false, derivatives: 0, message };
    }

    const backoff = BACKOFF_MINUTES[Math.min(attempt - 1, BACKOFF_MINUTES.length - 1)]!;
    await db
      .update(mediaJobs)
      .set({
        status: "queued",
        attempts: attempt,
        lastError: message,
        lockedAt: null,
        nextAttemptAt: new Date(Date.now() + backoff * 60_000),
        updatedAt: new Date(),
      })
      .where(eq(mediaJobs.id, job.id));

    return { assetPublicId: asset.publicId, ok: false, derivatives: 0, message };
  }
}

/**
 * Ask for an asset to be processed again.
 *
 * Resets the attempt count, because this is a person deciding to try rather
 * than the system retrying itself — and a client who fixes nothing and presses
 * Retry twice has still asked twice.
 */
export async function retryAsset(db: Database, assetId: string): Promise<void> {
  await db
    .update(mediaAssets)
    .set({ status: "processing", failureReason: null, updatedAt: new Date() })
    .where(and(eq(mediaAssets.id, assetId), inArray(mediaAssets.status, ["failed", "processing"])));

  const reopened = await db
    .update(mediaJobs)
    .set({
      status: "queued",
      attempts: 0,
      lastError: null,
      lockedAt: null,
      nextAttemptAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(mediaJobs.assetId, assetId), inArray(mediaJobs.status, ["failed", "cancelled"])))
    .returning({ id: mediaJobs.id });

  if (reopened.length === 0) {
    await enqueueDerivatives(db, assetId);
  }
}
