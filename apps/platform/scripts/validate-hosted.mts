/**
 * Validate the media library against a hosted deploy preview.
 *
 * Everything the local suite proves, it proves against Postgres running in
 * process and a local disk driver. That is the right place for logic, and the
 * wrong place for anything the *platform* decides: request and response
 * ceilings, function timeouts, Blobs latency and consistency, and how the
 * runtime behaves when several requests arrive at once. This script exercises
 * those, over real HTTP, and reports what it measured rather than what the
 * documentation claims.
 *
 * ## Refusing to run against production
 *
 * The first thing it does is check the target. A run of this pushes tens of
 * megabytes through the upload path, deliberately corrupts files, forces
 * derivative failures and abandons sessions. Against production that is
 * vandalism. The guard is a refusal, not a warning, and `--i-know` does not
 * exist.
 *
 * ## Usage
 *
 *   npx tsx scripts/validate-hosted.mts \
 *     --url https://deploy-preview-47--mortensenweb.netlify.app \
 *     --user owner@example.test --pass '…' \
 *     --other-user second@example.test --other-pass '…'
 *
 * Optional:
 *   --cron-secret   exercises the scheduled jobs (sweeper, reconciliation)
 *   --auth-secret   mints an agent download token, so the exact route the
 *                   agent uses can be tested. Must be the *preview's* secret.
 *   --json out.json writes the full measurements
 */

import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Arguments and safety
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const BASE = (arg("url") ?? "").replace(/\/$/, "");
const USER = arg("user");
const PASS = arg("pass");
const OTHER_USER = arg("other-user");
const OTHER_PASS = arg("other-pass");
const CRON_SECRET = arg("cron-secret");
const AUTH_SECRET = arg("auth-secret");
const JSON_OUT = arg("json");

/**
 * Hostnames this must never touch.
 *
 * Matched on the host, not on a substring of the whole URL — a check that
 * merely looked for "portal.mortensenweb.com" anywhere would be satisfied by a
 * query parameter and would let a typo through.
 */
const FORBIDDEN_HOSTS = new Set([
  "portal.mortensenweb.com",
  "mortensenweb.netlify.app",
  "mortensenweb.com",
  "www.mortensenweb.com",
]);

function assertSafeTarget(): void {
  if (!BASE) {
    console.error("--url is required.");
    process.exit(2);
  }
  let host: string;
  try {
    host = new URL(BASE).host.toLowerCase();
  } catch {
    console.error(`--url is not a URL: ${BASE}`);
    process.exit(2);
  }
  if (FORBIDDEN_HOSTS.has(host)) {
    console.error(
      `Refusing to run against ${host}. This script uploads tens of megabytes, ` +
        "corrupts files on purpose, forces failures and abandons sessions. Point " +
        "it at a deploy preview.",
    );
    process.exit(2);
  }
  // A deploy preview is `deploy-preview-<n>--<site>.netlify.app`; a branch
  // deploy is `<branch>--<site>.netlify.app`. Anything else is worth a pause.
  if (!/--[a-z0-9-]+\.netlify\.app$/.test(host) && !/^localhost(:\d+)?$/.test(host)) {
    console.error(
      `${host} does not look like a Netlify deploy preview or localhost. ` +
        "Refusing, rather than guessing that it is disposable.",
    );
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

interface Meter {
  requests: number;
  bytesSent: number;
  bytesReceived: number;
  wallMs: number;
}

const total: Meter = { requests: 0, bytesSent: 0, bytesReceived: 0, wallMs: 0 };
const perPhase = new Map<string, Meter>();
let phase = "setup";

function meter(): Meter {
  let m = perPhase.get(phase);
  if (!m) {
    m = { requests: 0, bytesSent: 0, bytesReceived: 0, wallMs: 0 };
    perPhase.set(phase, m);
  }
  return m;
}

const cookies = new Map<string, Map<string, string>>();

function jarFor(who: string): Map<string, string> {
  let jar = cookies.get(who);
  if (!jar) {
    jar = new Map();
    cookies.set(who, jar);
  }
  return jar;
}

/**
 * A fetch that measures.
 *
 * Bytes sent counts the body only; header overhead is small and, more to the
 * point, not what any of the platform limits are about. Bytes received counts
 * the body actually read, which is why every caller consumes the response.
 */
async function call(
  who: string,
  path: string,
  init: Omit<RequestInit, "body"> & { body?: Uint8Array | string } = {},
): Promise<{ status: number; headers: Headers; bytes: Uint8Array; text: string }> {
  const jar = jarFor(who);
  const headers = new Headers(init.headers);
  if (jar.size > 0) {
    headers.set(
      "cookie",
      [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
    );
  }

  const started = Date.now();
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    // A Uint8Array is a valid body at runtime; the DOM types in this
    // project do not model that overload.
    body: init.body as unknown as BodyInit | undefined,
    headers,
    redirect: "manual",
  });
  const buffer = new Uint8Array(await response.arrayBuffer());
  const elapsed = Date.now() - started;

  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const eq = pair!.indexOf("=");
    if (eq > 0) jar.set(pair!.slice(0, eq), pair!.slice(eq + 1));
  }

  const sent =
    init.body instanceof Uint8Array
      ? init.body.byteLength
      : typeof init.body === "string"
        ? Buffer.byteLength(init.body)
        : 0;

  for (const m of [total, meter()]) {
    m.requests += 1;
    m.bytesSent += sent;
    m.bytesReceived += buffer.byteLength;
    m.wallMs += elapsed;
  }

  return {
    status: response.status,
    headers: response.headers,
    bytes: buffer,
    text: new TextDecoder().decode(buffer.subarray(0, 4096)),
  };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
}

async function step<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    record(name, false, `threw: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * A JPEG of roughly the requested size, built with `sharp`.
 *
 * Noise rather than flat colour: a gradient compresses to almost nothing, and a
 * "12 MB" fixture that is really 200 KB would test none of the limits this
 * script exists to test.
 */
async function jpegOfSize(targetBytes: number): Promise<Uint8Array> {
  const sharp = (await import("sharp")).default;
  let side = Math.max(600, Math.round(Math.sqrt(targetBytes / 2.2)));

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const raw = Buffer.alloc(side * side * 3);
    for (let i = 0; i < raw.length; i += 1) raw[i] = (Math.random() * 256) | 0;

    const out = await sharp(raw, { raw: { width: side, height: side, channels: 3 } })
      .jpeg({ quality: 98 })
      .toBuffer();

    // Within 8% and never over: a fixture larger than the limit would test the
    // refusal path while claiming to test the acceptance path. Truncating to an
    // exact size is not an option — a cut JPEG is not a JPEG.
    if (out.length <= targetBytes && out.length >= targetBytes * 0.92) {
      return new Uint8Array(out);
    }
    side = Math.round(side * Math.sqrt((targetBytes / out.length) * 0.97));
  }
  throw new Error(`could not build a fixture of ${targetBytes} bytes`);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Sign in through the real credentials flow.
 *
 * next-auth requires a CSRF token from its own endpoint, echoed in the form
 * body. Doing it properly rather than forging a session cookie is the point:
 * the routes under test authenticate the same way a browser does, and a forged
 * cookie would prove nothing about that.
 */
async function signIn(who: string, email: string, password: string): Promise<boolean> {
  const csrfResponse = await call(who, "/api/auth/csrf");
  const csrfToken = (JSON.parse(csrfResponse.text) as { csrfToken: string }).csrfToken;

  const body = new URLSearchParams({
    csrfToken,
    // The provider's field is `identifier`, not `email` — it accepts the issued
    // handle (`northwind-comfort`) as well as an address. Getting this wrong
    // fails as "no session", which looks like a wrong password.
    identifier: email,
    password,
    callbackUrl: `${BASE}/dashboard`,
    json: "true",
  }).toString();

  const result = await call(who, "/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (result.status >= 400) return false;
  const jar = jarFor(who);
  return [...jar.keys()].some((k) => k.includes("session-token"));
}

// ---------------------------------------------------------------------------
// Upload helpers
// ---------------------------------------------------------------------------

interface Session {
  uploadPublicId: string;
  assetPublicId: string;
  partSize: number;
  partCount: number;
}

async function begin(
  who: string,
  bytes: Uint8Array,
  filename: string,
  folderPublicId: string | null = null,
): Promise<{ status: number; session?: Session; message?: string }> {
  const response = await call(who, "/api/media/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      filename,
      bytes: bytes.byteLength,
      checksum: await sha256Hex(bytes),
      contentType: "image/jpeg",
      folderPublicId,
    }),
  });
  if (response.status !== 201) {
    return { status: response.status, message: safeMessage(response.text) };
  }
  return { status: response.status, session: JSON.parse(response.text) as Session };
}

function safeMessage(text: string): string {
  try {
    return (JSON.parse(text) as { message?: string }).message ?? text.slice(0, 160);
  } catch {
    return text.slice(0, 160);
  }
}

async function sendPart(
  who: string,
  session: Session,
  partNumber: number,
  bytes: Uint8Array,
): Promise<number> {
  const start = (partNumber - 1) * session.partSize;
  const slice = bytes.subarray(start, Math.min(start + session.partSize, bytes.byteLength));
  const response = await call(
    who,
    `/api/media/uploads/${session.uploadPublicId}/parts/${partNumber}`,
    {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: slice,
    },
  );
  return response.status;
}

async function complete(who: string, session: Session) {
  const response = await call(who, `/api/media/uploads/${session.uploadPublicId}`, {
    method: "POST",
  });
  return { status: response.status, body: response.text };
}

/** Upload a whole file. `skip` omits one part, to test the missing-part path. */
interface UploadOutcome {
  status: number;
  session?: Session;
  message?: string;
  partStatuses: number[];
  completion?: { status: number; body: string };
}

async function uploadAll(
  who: string,
  bytes: Uint8Array,
  filename: string,
  options: { skip?: number; folderPublicId?: string | null } = {},
): Promise<UploadOutcome> {
  const begun = await begin(who, bytes, filename, options.folderPublicId ?? null);
  if (!begun.session) return { ...begun, partStatuses: [] };

  const statuses: number[] = [];
  for (let part = 1; part <= begun.session.partCount; part += 1) {
    if (options.skip === part) continue;
    statuses.push(await sendPart(who, begun.session, part, bytes));
  }
  const finished = await complete(who, begun.session);
  return { ...begun, partStatuses: statuses, completion: finished };
}

/** Wait for derivatives, reporting how long the platform actually took. */
async function waitForReady(
  who: string,
  assetPublicId: string,
  timeoutMs = 180_000,
): Promise<{ ready: boolean; elapsedMs: number; lastStatus: number }> {
  const started = Date.now();
  let lastStatus = 0;
  while (Date.now() - started < timeoutMs) {
    const response = await call(who, `/api/media/assets/${assetPublicId}/thumb`);
    lastStatus = response.status;
    if (response.status === 200) {
      return { ready: true, elapsedMs: Date.now() - started, lastStatus };
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  return { ready: false, elapsedMs: Date.now() - started, lastStatus };
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main() {
  assertSafeTarget();

  if (!USER || !PASS) {
    console.error("--user and --pass are required.");
    process.exit(2);
  }

  console.log(`Target: ${BASE}\n`);

  phase = "auth";
  const signedIn = await signIn("primary", USER, PASS);
  record("sign in as the test client", signedIn, signedIn ? USER : "no session cookie returned");
  if (!signedIn) {
    console.error("Cannot continue without a session.");
    process.exit(1);
  }

  let otherSignedIn = false;
  if (OTHER_USER && OTHER_PASS) {
    otherSignedIn = await signIn("other", OTHER_USER, OTHER_PASS);
    record(
      "sign in as a second, unrelated client",
      otherSignedIn,
      otherSignedIn ? OTHER_USER : "no session cookie returned",
    );
  }

  // -- 1. Large originals, including the configured maximum ---------------
  phase = "large-uploads";
  const { MAX_ORIGINAL_BYTES, UPLOAD_PART_BYTES } = await import("../src/lib/media/constants");

  const sizes = [
    { label: "just over the single-request ceiling", bytes: 7 * 1024 * 1024 },
    { label: "well over it", bytes: 11 * 1024 * 1024 },
    { label: "the configured maximum", bytes: MAX_ORIGINAL_BYTES },
  ];

  const uploaded: { label: string; assetPublicId: string; size: number }[] = [];

  for (const size of sizes) {
    await step(`upload ${size.label} (${mb(size.bytes)})`, async () => {
      const fixture = await jpegOfSize(size.bytes);
      const result = await uploadAll("primary", fixture, `large-${size.bytes}.jpg`);
      const ok = result.completion?.status === 200;
      const parts = result.session?.partCount ?? 0;
      record(
        `upload ${size.label} (${mb(fixture.byteLength)})`,
        ok,
        ok
          ? `${parts} parts of ${mb(UPLOAD_PART_BYTES)}, all accepted, checksum verified server-side`
          : `begin=${result.status} completion=${result.completion?.status} ${safeMessage(result.completion?.body ?? "")}`,
      );
      if (ok && result.session) {
        uploaded.push({
          label: size.label,
          assetPublicId: result.session.assetPublicId,
          size: fixture.byteLength,
        });
      }
    });
  }

  await step("refuse an original above the maximum", async () => {
    const oversize = MAX_ORIGINAL_BYTES + 1;
    const response = await call("primary", "/api/media/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "too-big.jpg",
        bytes: oversize,
        checksum: "a".repeat(64),
        contentType: "image/jpeg",
      }),
    });
    // 400 from schema validation and 413 from the size check are both correct
    // refusals; which one fires depends on whether the declared size trips the
    // request schema first. What matters is that it never reaches storage.
    record(
      "refuse an original above the maximum",
      response.status === 413 || response.status === 400,
      `${mb(oversize)} -> HTTP ${response.status}: ${safeMessage(response.text)}`,
    );
  });

  // -- 2. Resume, and checksum verification -------------------------------
  phase = "resume";
  await step("resume an interrupted upload", async () => {
    const fixture = await jpegOfSize(8 * 1024 * 1024);
    const begun = await begin("primary", fixture, "interrupted.jpg");
    if (!begun.session) throw new Error(`begin failed: ${begun.status}`);

    // Everything except the last part: the dropped-connection case.
    for (let part = 1; part < begun.session.partCount; part += 1) {
      await sendPart("primary", begun.session, part, fixture);
    }
    const firstTry = await complete("primary", begun.session);

    const held = await call(
      "primary",
      `/api/media/uploads/${begun.session.uploadPublicId}`,
    );
    const receivedParts = (JSON.parse(held.text) as { receivedParts: number[] })
      .receivedParts;

    await sendPart("primary", begun.session, begun.session.partCount, fixture);
    const secondTry = await complete("primary", begun.session);

    record(
      "resume an interrupted upload",
      firstTry.status === 409 && secondTry.status === 200,
      `incomplete -> ${firstTry.status}; server reported ${receivedParts.length}/${begun.session.partCount} parts held; ` +
        `after resending only the missing part -> ${secondTry.status}`,
    );
  });

  await step("reject bytes that do not match the declared checksum", async () => {
    const real = await jpegOfSize(7 * 1024 * 1024);
    const other = await jpegOfSize(7 * 1024 * 1024);

    const response = await call("primary", "/api/media/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "swapped.jpg",
        bytes: other.byteLength,
        checksum: await sha256Hex(real),
        contentType: "image/jpeg",
      }),
    });
    const session = JSON.parse(response.text) as Session;
    for (let part = 1; part <= session.partCount; part += 1) {
      await sendPart("primary", session, part, other);
    }
    const finished = await complete("primary", session);
    record(
      "reject bytes that do not match the declared checksum",
      finished.status === 409,
      `declared one file, sent another -> HTTP ${finished.status}: ${safeMessage(finished.body)}`,
    );
  });

  // -- 3. Derivative processing on the platform ---------------------------
  phase = "derivatives";
  for (const asset of uploaded) {
    await step(`derivatives complete for ${asset.label}`, async () => {
      const outcome = await waitForReady("primary", asset.assetPublicId);
      record(
        `derivatives complete for ${asset.label}`,
        outcome.ready,
        outcome.ready
          ? `ready after ${(outcome.elapsedMs / 1000).toFixed(1)}s`
          : `still not ready after ${(outcome.elapsedMs / 1000).toFixed(0)}s (last thumb status ${outcome.lastStatus})`,
      );
    });
  }

  // -- 4. Downloads, and the response ceiling -----------------------------
  phase = "downloads";
  for (const asset of uploaded) {
    await step(`download the original for ${asset.label}`, async () => {
      const whole = await call("primary", `/api/media/assets/${asset.assetPublicId}/original`);

      if (whole.status === 200) {
        const intact = whole.bytes.byteLength === asset.size;
        record(
          `download the original for ${asset.label}`,
          intact,
          `HTTP 200, ${mb(whole.bytes.byteLength)} received of ${mb(asset.size)} stored` +
            (intact ? " — byte count matches" : " — TRUNCATED"),
        );
        return;
      }

      if (whole.status === 413) {
        // Over the ceiling: prove the documented path actually works.
        const chunkSize = 4 * 1024 * 1024;
        const parts: Uint8Array[] = [];
        for (let start = 0; start < asset.size; start += chunkSize) {
          const end = Math.min(start + chunkSize - 1, asset.size - 1);
          const piece = await call(
            "primary",
            `/api/media/assets/${asset.assetPublicId}/original`,
            { headers: { range: `bytes=${start}-${end}` } },
          );
          if (piece.status !== 206) throw new Error(`range ${start}-${end} -> ${piece.status}`);
          parts.push(piece.bytes);
        }
        const joined = parts.reduce((n, p) => n + p.byteLength, 0);
        record(
          `download the original for ${asset.label}`,
          joined === asset.size,
          `whole-object -> 413 as designed; reassembled ${mb(joined)} of ${mb(asset.size)} over ${parts.length} ranged requests`,
        );
        return;
      }

      record(
        `download the original for ${asset.label}`,
        false,
        `unexpected HTTP ${whole.status}`,
      );
    });
  }

  await step("measure the actual response ceiling", async () => {
    // The documented figure is 20 MB for a streamed function. Whether the
    // runtime agrees, and whether anything base64-encodes on the way out, is
    // the sort of thing only a hosted request can answer.
    const biggest = uploaded.reduce(
      (best, a) => (a.size > (best?.size ?? 0) ? a : best),
      uploaded[0],
    );
    if (!biggest) throw new Error("nothing uploaded to measure with");

    const full = await call("primary", `/api/media/assets/${biggest.assetPublicId}/original`);
    record(
      "measure the actual response ceiling",
      true,
      `largest stored original ${mb(biggest.size)} -> HTTP ${full.status}, ` +
        `${mb(full.bytes.byteLength)} received. Configured serve limit is the governing number; ` +
        "compare this against it before raising either.",
    );
  });

  // -- 5. Cross-client isolation ------------------------------------------
  phase = "isolation";
  if (otherSignedIn && uploaded[0]) {
    const target = uploaded[0].assetPublicId;

    await step("a second client cannot read the first client's asset", async () => {
      const results = await Promise.all(
        ["original", "thumb", "preview"].map((variant) =>
          call("other", `/api/media/assets/${target}/${variant}`),
        ),
      );
      const allBlocked = results.every((r) => r.status === 404);
      record(
        "a second client cannot read the first client's asset",
        allBlocked,
        `variants answered ${results.map((r) => r.status).join(", ")} (404 expected for every one)`,
      );
    });

    await step("a second client cannot push parts into the first client's upload", async () => {
      const fixture = await jpegOfSize(7 * 1024 * 1024);
      const begun = await begin("primary", fixture, "victim.jpg");
      if (!begun.session) throw new Error("could not open a session");

      const intrusion = await call(
        "other",
        `/api/media/uploads/${begun.session.uploadPublicId}/parts/1`,
        {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: fixture.subarray(0, 1024),
        },
      );
      const completion = await call(
        "other",
        `/api/media/uploads/${begun.session.uploadPublicId}`,
        { method: "POST" },
      );
      record(
        "a second client cannot push parts into the first client's upload",
        intrusion.status === 404 && completion.status === 404,
        `part PUT -> ${intrusion.status}, complete -> ${completion.status} (404 expected for both)`,
      );
    });

    await step("a second client sees none of the first client's folders", async () => {
      const page = await call("other", "/dashboard/media");
      const leaked = uploaded.some((a) => page.text.includes(a.assetPublicId));
      record(
        "a second client sees none of the first client's folders",
        page.status === 200 && !leaked,
        `library page HTTP ${page.status}; no asset identifier from the first client appears in it`,
      );
    });
  } else {
    record(
      "cross-client isolation",
      false,
      "skipped — pass --other-user and --other-pass for a second tenant",
    );
  }

  await step("a forged agent token is refused", async () => {
    const forged = Buffer.from("media.AAAAAAAAAAAAAAAAAAAAAAAAAA.99999999999999")
      .toString("base64url");
    const response = await call("primary", `/api/media/agent/${forged}.${forged}`);
    record(
      "a forged agent token is refused",
      response.status === 404,
      `HTTP ${response.status} (404 expected, and identical to an unknown id)`,
    );
  });

  if (AUTH_SECRET && uploaded[0]) {
    await step("the exact agent download route serves an original", async () => {
      const expires = Date.now() + 10 * 60_000;
      const payload = `media.${uploaded[0]!.assetPublicId}.${expires}`;
      const signature = createHmac("sha256", AUTH_SECRET).update(payload).digest();
      const token = `${Buffer.from(payload).toString("base64url")}.${signature.toString("base64url")}`;

      const response = await call("primary", `/api/media/agent/${token}`);
      const ok = response.status === 200 || response.status === 413;
      record(
        "the exact agent download route serves an original",
        ok,
        `HTTP ${response.status}, ${mb(response.bytes.byteLength)} received, ` +
          `accept-ranges=${response.headers.get("accept-ranges")}`,
      );
    });
  } else {
    record(
      "the exact agent download route serves an original",
      false,
      "skipped — pass --auth-secret (the preview's, never production's) to mint a token",
    );
  }

  // -- 6. Quota under concurrency -----------------------------------------
  phase = "quota";
  await step("quota holds when uploads start simultaneously", async () => {
    // Sized at the per-image maximum so the burst is large enough to reach any
    // sensible allowance. Runs after the upload phases and releases everything
    // it claims, so it cannot starve them — but with a very small quota the
    // earlier phases will have consumed it first, which is why the recommended
    // allowance for a run is around 100 MB.
    const each = MAX_ORIGINAL_BYTES;
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        call("primary", "/api/media/uploads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            filename: `burst-${i}.jpg`,
            bytes: each,
            checksum: "b".repeat(64),
            contentType: "image/jpeg",
          }),
        }),
      ),
    );
    const granted = attempts.filter((a) => a.status === 201).length;
    const refused = attempts.filter((a) => a.status === 507).length;
    const other = attempts.length - granted - refused;

    // Everything granted means the tenant had room for everything, so the limit
    // was never reached and nothing about it was tested. Reporting that as a
    // pass would be the most misleading line in the whole report: it looks like
    // enforcement was proven when the code path never ran.
    const exercised = refused > 0;
    record(
      "quota holds when uploads start simultaneously",
      exercised && other === 0,
      exercised
        ? `${attempts.length} simultaneous starts of ${mb(each)}: ${granted} granted, ${refused} refused ` +
          `for quota, ${other} other. The limit was reached and held under concurrency.`
        : `NOT EXERCISED — all ${attempts.length} starts of ${mb(each)} were granted, so the tenant had ` +
          `room for ${mb(each * attempts.length)} and the limit was never reached. Set ` +
          "clients.media_quota_bytes on the test client to about 100 MB and run again.",
    );

    // Release what was claimed, so the rest of the run is not starved.
    for (const attempt of attempts) {
      if (attempt.status !== 201) continue;
      const session = JSON.parse(attempt.text) as Session;
      await call("primary", `/api/media/uploads/${session.uploadPublicId}`, {
        method: "DELETE",
      });
    }
  });

  // -- 7. Scheduled jobs ---------------------------------------------------
  phase = "scheduled";
  if (CRON_SECRET) {
    await step("the scheduled tick runs the media jobs", async () => {
      const response = await call("primary", "/api/cron", {
        method: "POST",
        headers: { "x-cron-secret": CRON_SECRET, "x-nudge-reason": "hosted validation" },
      });
      const body = JSON.parse(response.text) as Record<string, unknown>;
      const present =
        "mediaDerivatives" in body &&
        "mediaUploadsSwept" in body &&
        "storageReconciled" in body;
      record(
        "the scheduled tick runs the media jobs",
        response.status === 200 && present,
        `HTTP ${response.status}; derivatives=${JSON.stringify(body.mediaDerivatives)} ` +
          `swept=${JSON.stringify(body.mediaUploadsSwept)} reconciled=${JSON.stringify(body.storageReconciled)}`,
      );
    });
  } else {
    record(
      "the scheduled tick runs the media jobs",
      false,
      "skipped — pass --cron-secret to exercise the sweeper and reconciliation",
    );
  }

  // -- 8. Request idempotency ----------------------------------------------
  phase = "requests";
  record(
    "request idempotency and rollback",
    false,
    "not exercised here — these go through server actions rather than a JSON API, " +
      "so they are checked in the browser against the same preview. See the report.",
  );

  // -- Summary -------------------------------------------------------------
  console.log("\n=== Measured usage ===");
  for (const [name, m] of perPhase) {
    console.log(
      `${name.padEnd(16)} ${String(m.requests).padStart(4)} requests  ` +
        `up ${mb(m.bytesSent).padStart(9)}  down ${mb(m.bytesReceived).padStart(9)}  ` +
        `${(m.wallMs / 1000).toFixed(1)}s`,
    );
  }
  console.log(
    `${"TOTAL".padEnd(16)} ${String(total.requests).padStart(4)} requests  ` +
      `up ${mb(total.bytesSent).padStart(9)}  down ${mb(total.bytesReceived).padStart(9)}  ` +
      `${(total.wallMs / 1000).toFixed(1)}s`,
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);

  if (JSON_OUT) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      JSON_OUT,
      JSON.stringify(
        { target: BASE, checks, usage: { total, perPhase: [...perPhase] } },
        null,
        2,
      ),
    );
    console.log(`Measurements written to ${JSON_OUT}`);
  }

  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
