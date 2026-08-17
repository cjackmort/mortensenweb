/**
 * The build.
 *
 * Copies `src/` to `dist/`. That is the whole of it, and the absence of a
 * framework is the point rather than a shortcut.
 *
 * These sites are five or six pages of content for a small business. A static
 * site generator would add a dependency tree to maintain, a lockfile to keep
 * current, upgrade work every year, and a layer of templating syntax between an
 * agent and the words on the page — in exchange for conveniences this size of
 * site does not need.
 *
 * The agent benefit is the one that decides it. A change request usually reads
 * "change the phone number in the footer" or "swap the photo on the services
 * page". Against plain HTML that is a find-and-replace an agent gets right
 * every time. Against a framework it becomes: locate the component, work out
 * which prop feeds it, find where the prop comes from, and hope the data file
 * is not generated. More steps, more ways to be subtly wrong, on the exact
 * operation these repositories exist to perform.
 *
 * Zero dependencies also means `npm ci` is instant and can never fail on a
 * transitive package, which matters when a deploy is on the path between a
 * client pressing Apply and their website updating.
 *
 * When a site genuinely outgrows this, replace it — the deploy workflow only
 * requires that `npm run build` produces `dist`.
 */

import { cp, mkdir, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const SRC = "src";
const OUT = "dist";

async function build() {
  if (!existsSync(SRC)) {
    console.error(`No ${SRC}/ directory — nothing to build.`);
    process.exit(1);
  }

  // Removed rather than overwritten: a file deleted from src/ must disappear
  // from the site, and a copy-over-the-top leaves it published forever.
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await cp(SRC, OUT, { recursive: true });

  const entries = await readdir(OUT, { recursive: true });
  console.log(`Built ${entries.length} files into ${OUT}/`);

  if (!existsSync(join(OUT, "index.html"))) {
    // A site with no index is a deploy that "succeeds" and serves a 404 at the
    // front door. Better to fail here, where the log is read.
    console.error("Warning: no index.html at the site root.");
    process.exit(1);
  }
}

await build();
