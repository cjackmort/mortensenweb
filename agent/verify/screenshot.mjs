#!/usr/bin/env node
/**
 * Screenshots of the pages a change touched, written into the build so they
 * deploy with the preview.
 *
 *   node screenshot.mjs dist [--base <sha>] [--all]
 *
 * Output: dist/__preview/<page>-<width>.png for the home page and every HTML
 * page changed since `--base` (default: origin/main), at 390px and 1280px,
 * plus dist/__preview/index.json listing them. The portal shows the 390px
 * home shot beside the approve button; the pull request comment lists all.
 *
 * Requires Playwright (`npm i -g playwright@1.50.1 && playwright install
 * --with-deps chromium`); resolved from the global root so the client
 * repository carries no dependency. Serves dist/ itself on a local port.
 *
 * Deliberately generous with time: fonts load, entrance animations finish.
 * A screenshot of a page mid-fade tells the client nothing.
 */

import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, resolve, extname, relative } from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const root = resolve(args.find((a) => !a.startsWith("--")) ?? "dist");
const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : "origin/main";
const all = args.includes("--all");

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".avif": "image/avif", ".woff2": "font/woff2", ".woff": "font/woff", ".json": "application/json", ".ico": "image/x-icon",
};

function serve() {
  return new Promise((done) => {
    const server = createServer((req, res) => {
      let path = decodeURIComponent((req.url ?? "/").split("?")[0]);
      let file = join(root, path);
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
      if (!existsSync(file) && existsSync(`${file}.html`)) file = `${file}.html`;
      if (!existsSync(file)) { res.statusCode = 404; res.end("not found"); return; }
      res.setHeader("content-type", MIME[extname(file).toLowerCase()] ?? "application/octet-stream");
      res.end(readFileSync(file));
    });
    server.listen(0, "127.0.0.1", () => done({ server, port: server.address().port }));
  });
}

/** Pages to shoot: home, plus each changed src/*.html mapped to its built path. */
function changedPages() {
  const pages = new Set(["/"]);
  if (all) {
    const walk = (dir, prefix = "") => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { if (entry !== "__preview") walk(full, `${prefix}/${entry}`); }
        else if (entry.endsWith(".html")) pages.add(`${prefix}/${entry}`.replace(/\/index\.html$/, "/"));
      }
    };
    walk(root);
    return [...pages];
  }
  try {
    const diff = execSync(`git diff --name-only ${base}...HEAD`, { encoding: "utf8" });
    for (const line of diff.split("\n")) {
      const f = line.trim();
      if (!f.endsWith(".html")) continue;
      // src/about.html -> /about.html ; src/index.html -> / ; src/work/index.html -> /work/
      const stripped = f.replace(/^(src|public|site|pages)\//, "");
      const url = `/${stripped}`.replace(/\/index\.html$/, "/");
      if (existsSync(join(root, stripped))) pages.add(url);
    }
  } catch {
    // No git history to compare against (a fresh clone with a shallow fetch):
    // the home page alone is still worth having.
  }
  return [...pages];
}

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  // Resolved through the npx cache when the package is not installed locally.
  const out = execSync("npm root -g", { encoding: "utf8" }).trim();
  ({ chromium } = require(join(out, "playwright")));
}

const { server, port } = await serve();
const outDir = join(root, "__preview");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const shots = [];
const pages = changedPages();
console.log(`Screenshotting ${pages.length} page(s): ${pages.join(", ")}`);

for (const page of pages) {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({
      viewport: { width, height: width < 600 ? 844 : 800 },
      deviceScaleFactor: width < 600 ? 2 : 1,
      isMobile: width < 600,
      reducedMotion: "reduce",
    });
    const tab = await context.newPage();
    try {
      await tab.goto(`http://127.0.0.1:${port}${page}`, { waitUntil: "networkidle", timeout: 30_000 });
      await tab.waitForTimeout(800);
      const slug = page === "/" ? "home" : page.replace(/^\/|\/$/g, "").replace(/\.html$/, "").replace(/[^a-z0-9]+/gi, "-");
      const file = `${slug}-${width}.png`;
      await tab.screenshot({ path: join(outDir, file), fullPage: true });
      shots.push({ page, width, file: `/__preview/${file}` });
      console.log(`  ${file}`);
    } catch (error) {
      console.warn(`  could not screenshot ${page} at ${width}: ${error.message}`);
    } finally {
      await context.close();
    }
  }
}

await browser.close();
server.close();

writeFileSync(join(outDir, "index.json"), JSON.stringify({ generatedAt: new Date().toISOString(), shots }, null, 2));
console.log(`Wrote ${shots.length} screenshot(s) to ${relative(process.cwd(), outDir)}/`);
