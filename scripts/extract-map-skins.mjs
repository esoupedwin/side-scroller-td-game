#!/usr/bin/env node
// Move embedded skin images out of src/defaultMapData.json into real files.
//
// The map builder stores every skin (backgrounds, ground, decor, platforms,
// blocks, coins, tower templates) as a base64 data URL, which is what makes the
// baked JSON ~3.6 MB and drags it into the main JS bundle — on a 1.6 Mbps
// connection that alone is ~15 s before the first frame. The game and the
// builder only ever hand these strings to an image loader, so a path works
// just as well: this walks the JSON, writes each data URL to
// public/maps/skins/<sha1>.<ext> (content-addressed, so re-runs are no-ops and
// identical images share a file), and rewrites the JSON to reference it.
//
// Run after every "Bake defaultMapData.json":   node scripts/extract-map-skins.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root    = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const jsonPath = resolve(root, 'src/defaultMapData.json');
const outDir   = resolve(root, 'public/maps/skins');
const urlBase  = '/maps/skins';
mkdirSync(outDir, { recursive: true });

const EXT = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/gif': 'gif' };
let files = 0, bytesOut = 0, bytesIn = 0, reused = 0;

function extract(dataUrl) {
  const m = /^data:(image\/[a-z+]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) return dataUrl;
  const ext = EXT[m[1]] ?? 'bin';
  const buf = Buffer.from(m[2], 'base64');
  const name = `${createHash('sha1').update(buf).digest('hex').slice(0, 16)}.${ext}`;
  const file = resolve(outDir, name);
  bytesIn += dataUrl.length;
  if (existsSync(file)) reused++; else { writeFileSync(file, buf); files++; bytesOut += buf.length; }
  return `${urlBase}/${name}`;
}
function walk(v) {
  if (typeof v === 'string') return v.startsWith('data:image/') ? extract(v) : v;
  if (Array.isArray(v)) return v.map(walk);
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) v[k] = walk(v[k]); }
  return v;
}

const before = readFileSync(jsonPath, 'utf8');
const data = walk(JSON.parse(before));
const after = JSON.stringify(data, null, 2) + '\n';
writeFileSync(jsonPath, after);
console.log(`defaultMapData.json: ${(before.length / 1024).toFixed(0)} KB → ${(after.length / 1024).toFixed(0)} KB;` +
  ` ${files} new skin file(s) (${(bytesOut / 1024).toFixed(0)} KB), ${reused} already present, ${(bytesIn / 1024).toFixed(0)} KB of base64 removed`);
