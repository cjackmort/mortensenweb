/**
 * Photograph every client's home page for the admin tiles.
 *
 * Run by `.github/workflows/site-thumbnails.yml`. Asks the portal which sites
 * to photograph, takes a 1280x800 picture of each, and uploads it. The portal
 * stores it and the tiles show it (see `src/lib/thumbnails.ts`).
 *
 * Playwright is installed by the workflow into the working directory rather
 * than being a dependency of the portal, so it is resolved from there.
 *
 *   PORTAL_URL=https://portal.mortensenweb.com CRON_SECRET=… node capture-thumbnails.mjs
 *
 * One site failing never stops the rest. The run fails only when every site
 * did, which is what a wrong secret or a down portal looks like.
 */

import { createRequire } from "node:module";

const require = createRequire(`${process.cwd()}/`);
const { chromium } = require("playwright");

const PORTAL = (process.env.PORTAL_URL ?? "https://portal.mortensenweb.com").replace(/\/$/, "");
const SECRET = process.env.CRON_SECRET ?? "";
const VIEWPORT = { width: 1280, height: 800 };
const LOAD_TIMEOUT_MS = 30_000;
// Long enough for a hero's fade-in to finish, short enough to stay cheap.
const SETTLE_MS = 1_500;

if (!SECRET) {
  console.log("::warning::CRON_SECRET is not set, so no thumbnails were taken.");
  process.exit(0);
}

const headers = { "x-cron-secret": SECRET };

const listing = await fetch(`${PORTAL}/api/thumbnails`, { headers });
if (!listing.ok) {
  console.error(`The portal refused the site list: ${listing.status} ${await listing.text()}`);
  process.exit(1);
}
const { sites } = await listing.json();
console.log(`${sites.length} site(s) to photograph.`);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: VIEWPORT, reducedMotion: "reduce" });
let saved = 0;

for (const site of sites) {
  const page = await context.newPage();
  try {
    await page.goto(site.url, { waitUntil: "networkidle", timeout: LOAD_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);
    const jpeg = await page.screenshot({ type: "jpeg", quality: 70 });

    const upload = await fetch(`${PORTAL}/api/thumbnails/${site.publicId}`, {
      method: "PUT",
      headers: { ...headers, "content-type": "image/jpeg" },
      body: jpeg,
    });
    if (!upload.ok) throw new Error(`upload refused: ${upload.status} ${await upload.text()}`);

    saved += 1;
    console.log(`ok    ${site.url} (${Math.round(jpeg.byteLength / 1024)} KB)`);
  } catch (error) {
    console.log(`::warning::${site.url}: ${error instanceof Error ? error.message : error}`);
  } finally {
    await page.close();
  }
}

await browser.close();
console.log(`${saved} of ${sites.length} saved.`);
if (sites.length > 0 && saved === 0) process.exit(1);
