#!/usr/bin/env node
// Placeholder SVG generator — no dependencies.
// node placeholder.mjs --style mesh --w 1600 --h 900 --colors "#F6F1E7,#8C2F1B,#2E5E4E" --label "Hero" --seed 7 --out hero.svg [--grain] [--text "WORD"]

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "true";
      acc.push([k, v]);
    }
    return acc;
  }, [])
);

const style = args.style || "mesh";
const W = +args.w || 1600, H = +args.h || 900;
const colors = (args.colors || "#F4F5F7,#10233F,#F25C2E,#0E9F9F").split(",").map(s => s.trim());
const [bg, c1, c2 = c1, c3 = c2] = colors;
const label = args.label || "";
const bigText = args.text || "";
const seed = +args.seed || 1;
const grain = args.grain === "true";
const out = args.out || `placeholder-${style}-${W}x${H}.svg`;

// Deterministic PRNG (mulberry32)
let s = seed >>> 0;
const rnd = () => { s += 0x6D2B79F5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const R = (a, b) => a + rnd() * (b - a);
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const esc = t => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");

const defs = [];
let body = "";

function grainFilter() {
  defs.push(`<filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="table" tableValues="0 0 0.18"/></feComponentTransfer></filter>`);
  return `<rect width="${W}" height="${H}" filter="url(#grain)" opacity="0.5"/>`;
}

switch (style) {
  case "mesh": {
    defs.push(`<filter id="blur"><feGaussianBlur stdDeviation="${Math.max(W, H) / 9}"/></filter>`);
    body += `<rect width="${W}" height="${H}" fill="${bg}"/><g filter="url(#blur)">`;
    for (const c of [c1, c2, c3, c1]) body += `<ellipse cx="${R(0, W)}" cy="${R(0, H)}" rx="${R(W * .25, W * .5)}" ry="${R(H * .25, H * .55)}" fill="${c}" opacity="${R(.55, .9)}"/>`;
    body += `</g>`;
    break;
  }
  case "duotone": {
    defs.push(`<pattern id="p" width="48" height="48" patternUnits="userSpaceOnUse" patternTransform="rotate(${Math.round(R(0, 90))})"><rect width="48" height="48" fill="${bg}"/><circle cx="24" cy="24" r="${R(3, 9).toFixed(1)}" fill="${c1}" opacity=".9"/></pattern>`);
    body += `<rect width="${W}" height="${H}" fill="url(#p)"/><rect x="${W * .12}" y="${H * .18}" width="${W * .55}" height="${H * .64}" fill="${c2}" opacity=".92"/>`;
    break;
  }
  case "geometric": {
    body += `<rect width="${W}" height="${H}" fill="${bg}"/>`;
    const n = 7;
    for (let i = 0; i < n; i++) {
      const c = pick([c1, c2, c3]); const t = pick(["circle", "rect", "tri"]);
      const x = R(0, W), y = R(0, H), r = R(Math.min(W, H) * .08, Math.min(W, H) * .32);
      if (t === "circle") body += `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}"/>`;
      else if (t === "rect") body += `<rect x="${x - r}" y="${y - r * .35}" width="${r * 2}" height="${r * .7}" fill="${c}" transform="rotate(${pick([0, 0, 45, 90])} ${x} ${y})"/>`;
      else body += `<polygon points="${x},${y - r} ${x + r},${y + r} ${x - r},${y + r}" fill="${c}"/>`;
    }
    break;
  }
  case "blobs": {
    body += `<rect width="${W}" height="${H}" fill="${bg}"/>`;
    for (const c of [c1, c2, c3]) {
      const cx = R(W * .25, W * .75), cy = R(H * .25, H * .75), r = R(Math.min(W, H) * .22, Math.min(W, H) * .42);
      let d = ""; const k = 8;
      for (let i = 0; i <= k; i++) { const a = (i / k) * Math.PI * 2; const rr = r * R(.8, 1.15); const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr; d += (i ? " L" : "M") + x.toFixed(1) + " " + y.toFixed(1); }
      body += `<path d="${d} Z" fill="${c}" opacity=".85" stroke-linejoin="round" stroke="${c}" stroke-width="${r * .3}"/>`;
    }
    break;
  }
  case "lineart": {
    body += `<rect width="${W}" height="${H}" fill="${bg}"/>`;
    const cx = W / 2, cy = H / 2, r = Math.min(W, H) * .3;
    body += `<g fill="none" stroke="${c1}" stroke-width="${Math.max(2, r * .02)}" stroke-linecap="round"><circle cx="${cx}" cy="${cy}" r="${r}"/><path d="M${cx - r * .6} ${cy + r * .2} q${r * .6} -${r * .9} ${r * 1.2} 0"/><line x1="${cx - r * 1.3}" y1="${cy + r * .8}" x2="${cx + r * 1.3}" y2="${cy + r * .8}"/></g>`;
    break;
  }
  case "halftone": {
    defs.push(`<pattern id="ht" width="14" height="14" patternUnits="userSpaceOnUse"><circle cx="7" cy="7" r="3.2" fill="${c1}"/></pattern>`);
    body += `<rect width="${W}" height="${H}" fill="${bg}"/><rect width="${W}" height="${H}" fill="url(#ht)" opacity=".5"/><circle cx="${W * .62}" cy="${H * .5}" r="${Math.min(W, H) * .34}" fill="${c2}"/>`;
    break;
  }
  case "chrome": {
    defs.push(`<radialGradient id="sph" cx="35%" cy="30%" r="70%"><stop offset="0" stop-color="#fff"/><stop offset=".35" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></radialGradient><linearGradient id="hz" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="${c3}"/></linearGradient>`);
    body += `<rect width="${W}" height="${H}" fill="url(#hz)"/><g stroke="${c1}" stroke-opacity=".35">`;
    for (let i = 0; i <= 12; i++) body += `<line x1="${(i / 12) * W}" y1="${H * .55}" x2="${W / 2 + ((i / 12) * W - W / 2) * 3}" y2="${H}"/>`;
    for (let i = 1; i <= 6; i++) body += `<line x1="0" y1="${H * .55 + (i * i) * (H * .45 / 36)}" x2="${W}" y2="${H * .55 + (i * i) * (H * .45 / 36)}"/>`;
    body += `</g><circle cx="${W * .5}" cy="${H * .42}" r="${Math.min(W, H) * .22}" fill="url(#sph)"/>`;
    break;
  }
  case "tone": {
    defs.push(`<radialGradient id="vg" cx="50%" cy="45%" r="75%"><stop offset="0" stop-color="${c1}" stop-opacity=".35"/><stop offset="1" stop-color="${c2}" stop-opacity=".9"/></radialGradient>`);
    body += `<rect width="${W}" height="${H}" fill="${bg}"/><rect width="${W}" height="${H}" fill="url(#vg)"/>`;
    break;
  }
  case "frame":
  default: {
    body += `<rect width="${W}" height="${H}" fill="${bg}"/><rect x="1" y="1" width="${W - 2}" height="${H - 2}" fill="none" stroke="${c1}" stroke-width="2" stroke-dasharray="8 8"/><line x1="0" y1="0" x2="${W}" y2="${H}" stroke="${c1}" stroke-opacity=".25"/><line x1="${W}" y1="0" x2="0" y2="${H}" stroke="${c1}" stroke-opacity=".25"/>`;
    body += `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" dominant-baseline="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="${Math.max(14, Math.min(W, H) * .045)}" fill="${c1}">${W}×${H}${label ? " · " + esc(label) : ""}</text>`;
  }
}

if (grain) body += grainFilter();
if (bigText) body += `<text x="${W * .06}" y="${H * .82}" font-family="Georgia, serif" font-weight="700" font-size="${Math.min(W * .12, H * .28)}" fill="${style === "chrome" || style === "tone" ? bg : c2}" letter-spacing="-0.02em">${esc(bigText)}</text>`;
if (label && style !== "frame") body += `<text x="${W - 24}" y="${H - 20}" text-anchor="end" font-family="ui-monospace, monospace" font-size="${Math.max(12, Math.min(W, H) * .02)}" fill="${c2}" opacity=".7">${esc(label)} · ${W}×${H}</text>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label || "Placeholder image")}">${defs.length ? `<defs>${defs.join("")}</defs>` : ""}${body}</svg>`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, svg);
console.log(`wrote ${out} (${style}, ${W}x${H}, seed ${seed})`);
