#!/usr/bin/env node
/**
 * Structural checks on a built site. No browser, no dependencies.
 *
 *   node check.mjs dist [--report verify-report.md] [--json]
 *
 * Exit code 1 when anything is an *error* — a link or image that points at a
 * file that does not exist, an image with no alt attribute, a page with no
 * title, an image loaded from another site. Warnings (placeholder text still
 * present, very large images, a page with no h1) are reported but do not
 * fail, because a site scaffolded with placeholders is allowed to be deployed
 * to a preview; it is not allowed to have broken references.
 *
 * Why these checks and not a validator: the failures that reach a client are
 * almost never invalid HTML. They are a renamed image whose old path is still
 * in the markup, a photo that was referenced but never committed, a preload
 * pointing at the previous hero. Those are what an agent gets wrong, and they
 * are exactly what a file-resolution pass catches.
 */

import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname, resolve, relative, posix } from "node:path";

const args = process.argv.slice(2);
const root = resolve(args.find((a) => !a.startsWith("--")) ?? "dist");
const reportPath = args.includes("--report") ? args[args.indexOf("--report") + 1] : null;
const asJson = args.includes("--json");

if (!existsSync(root)) {
  console.error(`No such directory: ${root}`);
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "__preview") continue;
      out.push(...walk(full));
    } else out.push(full);
  }
  return out;
}

const files = walk(root);
const pages = files.filter((f) => f.endsWith(".html"));
const errors = [];
const warnings = [];

const ATTR = /\b(src|href|srcset|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const IMG = /<img\b[^>]*>/gi;
const ALT = /\balt\s*=/i;
const TITLE = /<title>\s*([^<]*?)\s*<\/title>/i;
const H1 = /<h1[\s>]/i;
const PLACEHOLDER = /\[[A-Z][A-Z0-9 ,.'’\-—–/]{2,}\]/g;
const LOREM = /lorem ipsum/i;

function resolveLocal(fromPage, target) {
  // Strip query and hash, decode percent-encoding.
  let path = target.split("#")[0].split("?")[0];
  try { path = decodeURIComponent(path); } catch { /* keep as is */ }
  if (path === "") return null;
  const base = path.startsWith("/") ? root : dirname(fromPage);
  let full = resolve(base, path.startsWith("/") ? `.${path}` : path);
  // A directory URL means its index.html; a bare path may mean path.html.
  if (existsSync(full) && statSync(full).isDirectory()) full = join(full, "index.html");
  if (!existsSync(full) && !posix.extname(path) && existsSync(`${full}.html`)) full = `${full}.html`;
  return full;
}

function isExternal(url) {
  return /^(https?:)?\/\//i.test(url) || /^(mailto|tel|sms|data|javascript|blob):/i.test(url);
}

for (const page of pages) {
  const rel = relative(root, page);
  const html = readFileSync(page, "utf8");

  const title = TITLE.exec(html)?.[1];
  if (!title) errors.push({ page: rel, message: "No <title>." });
  if (!H1.test(html)) warnings.push({ page: rel, message: "No <h1> on the page." });

  const placeholders = html.match(PLACEHOLDER) ?? [];
  if (placeholders.length) {
    warnings.push({
      page: rel,
      message: `${placeholders.length} placeholder${placeholders.length === 1 ? "" : "s"} still present: ${[...new Set(placeholders)].slice(0, 5).join(", ")}`,
    });
  }
  if (LOREM.test(html)) errors.push({ page: rel, message: "Lorem ipsum in shipped copy." });

  for (const tag of html.match(IMG) ?? []) {
    if (!ALT.test(tag)) errors.push({ page: rel, message: `<img> without alt: ${tag.slice(0, 80)}` });
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (src && /^https?:\/\//i.test(src)) {
      errors.push({ page: rel, message: `Image loaded from another site: ${src}` });
    }
  }

  ATTR.lastIndex = 0;
  let match;
  while ((match = ATTR.exec(html))) {
    const attr = match[1].toLowerCase();
    const raw = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (!raw) continue;
    const candidates = attr === "srcset"
      ? raw.split(",").map((s) => s.trim().split(/\s+/)[0]).filter(Boolean)
      : [raw];
    for (const url of candidates) {
      if (isExternal(url) || url.startsWith("#")) continue;
      const full = resolveLocal(page, url);
      if (!full) continue;
      if (!existsSync(full)) {
        errors.push({ page: rel, message: `${attr}="${url}" does not resolve to a file in ${relative(process.cwd(), root)}/.` });
      } else if (/\.(jpe?g|png|webp|gif|avif)$/i.test(full)) {
        const kb = Math.round(statSync(full).size / 1024);
        if (kb > 600) warnings.push({ page: rel, message: `${url} is ${kb} KB — larger than a page should carry; resize it.` });
      }
    }
  }
}

if (pages.length === 0) errors.push({ page: "(site)", message: "No HTML pages found in the build output." });
if (!existsSync(join(root, "index.html"))) errors.push({ page: "(site)", message: "No index.html at the site root." });

const result = { pages: pages.length, errors, warnings };

function md() {
  const lines = [];
  lines.push(`Checked ${pages.length} page${pages.length === 1 ? "" : "s"}: **${errors.length} error${errors.length === 1 ? "" : "s"}**, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.`);
  if (errors.length) {
    lines.push("", "**Errors (must fix):**");
    for (const e of errors) lines.push(`- \`${e.page}\` — ${e.message}`);
  }
  if (warnings.length) {
    lines.push("", "**Warnings:**");
    for (const w of warnings) lines.push(`- \`${w.page}\` — ${w.message}`);
  }
  return lines.join("\n");
}

if (reportPath) writeFileSync(reportPath, md() + "\n");
if (asJson) console.log(JSON.stringify(result, null, 2));
else console.log(md());

process.exit(errors.length ? 1 : 0);
