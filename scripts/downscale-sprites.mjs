// One-time sprite-sheet downscaler.
//
// The source sheets are 4800px-wide (800px frames). Characters render at most
// ~340px tall, so the art is ~3-5x oversized — the single biggest contributor
// to start-up load time and texture memory. This rescales every sheet by SCALE
// (0.64 -> 512px frames, still above the max render size) using a high-quality
// Lanczos3 kernel, preserving alpha.
//
// Originals are copied to BACKUP_DIR before being overwritten (git also holds
// the originals). Re-running is idempotent: it always resizes from the backup,
// so running twice does not double-shrink.
//
//   node scripts/downscale-sprites.mjs            # downscale (backup first)
//   node scripts/downscale-sprites.mjs --restore  # restore originals from backup

import sharp from 'sharp';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT       = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPRITES_DIR = path.join(ROOT, 'public', 'sprites');
const BACKUP_DIR  = path.join(ROOT, '.sprites-backup-4800');
const SCALE       = 0.64;  // 800px frames -> 512px frames

async function walk(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (e.isFile() && e.name.toLowerCase().endsWith('.png')) out.push(p);
  }
  return out;
}

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function restore() {
  if (!await exists(BACKUP_DIR)) { console.error('No backup dir — nothing to restore.'); process.exit(1); }
  const files = await walk(BACKUP_DIR);
  for (const src of files) {
    const dest = path.join(SPRITES_DIR, path.relative(BACKUP_DIR, src));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  }
  console.log(`Restored ${files.length} files from backup.`);
}

async function downscale() {
  const files = await walk(SPRITES_DIR);
  let before = 0, after = 0;

  for (const file of files) {
    const rel    = path.relative(SPRITES_DIR, file);
    const backup = path.join(BACKUP_DIR, rel);

    // Back up the original once; thereafter always resize FROM the backup so the
    // operation is idempotent (never shrinks an already-shrunk file again).
    if (!await exists(backup)) {
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.copyFile(file, backup);
    }

    const meta = await sharp(backup).metadata();
    const w = Math.round(meta.width  * SCALE);
    const h = Math.round(meta.height * SCALE);

    const buf = await sharp(backup)
      .resize(w, h, { kernel: 'lanczos3', fit: 'fill' })
      .png({ compressionLevel: 9 })
      .toBuffer();
    await fs.writeFile(file, buf);

    before += (await fs.stat(backup)).size;
    after  += buf.length;
    console.log(`${rel}: ${meta.width}x${meta.height} -> ${w}x${h}`);
  }

  const mb = (n) => (n / 1048576).toFixed(1);
  console.log(`\n${files.length} sheets: ${mb(before)} MB -> ${mb(after)} MB (${(100 * (1 - after / before)).toFixed(0)}% smaller)`);
}

if (process.argv.includes('--restore')) await restore();
else                                     await downscale();
