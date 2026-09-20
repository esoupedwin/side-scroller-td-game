import * as PIXI from 'pixi.js';
import { TRIBE_ROSTERS, type Tribe } from './Tribes';
import { charConfig, charSpriteFolder, GAME_ZOOM } from './constants';
import { getRenderScale } from './resolution';

// Each character renders as two stacked PIXI.AnimatedSprite layers that
// animate independently:
//   • Body  (front) — torso/arms/head: idle, walk, attack, carry
//   • Legs  (back)  — legs only:        idle, walk
// This lets any body pose pair with any leg state (e.g. legs=walk + body=attack
// for a marching unit that fires opportunistically) without extra art.
export type BodyAnimName = 'idle' | 'walk' | 'attack' | 'carry' | 'throw';
export type LegsAnimName = 'idle' | 'walk';

// Sprite sheets are laid out left-to-right, top-to-bottom, with exactly
// FRAMES_PER_ROW frames per row. Frame height is fixed by artist convention
// (FRAME_HEIGHT_PX); row count is derived from the sheet's height. The actual
// frame count within the grid is detected from the image (trailing empty cells
// in the last row are skipped).
const FRAMES_PER_ROW = 6;
// Frame height after the one-time downscale (scripts/downscale-sprites.mjs):
// sheets are 512px-tall frames (3072×3072 / 3072×2048). Row count is derived as
// sheet.height / FRAME_HEIGHT_PX. If you replace the sheets at a different
// resolution, update this to the new frame height.
const FRAME_HEIGHT_PX = 512;

// Per-sheet load logging — 112 lines at startup. Flip on only when debugging sheets.
const DEBUG_SPRITES = false;

export interface SpriteLayerAnimDef {
  path:        string;  // URL served from /public, e.g. '/sprites/kattgard/warrior/body/walk.png'
  fps:         number;  // desired playback speed in frames per second
  spriteScale: number;  // height = config.height * spriteScale (compensates for frame padding)
  feetAnchorY?: number; // 0..1; where in the frame the character's feet sit (default 1 = bottom edge).
                        // Lower this when the art has empty padding below the character.
  rows?:       number;  // optional override; auto-derived from sheet.height / FRAME_HEIGHT_PX otherwise.
}

export type BodyLayerDef = Partial<Record<BodyAnimName, SpriteLayerAnimDef>>;
export type LegsLayerDef = Partial<Record<LegsAnimName, SpriteLayerAnimDef>>;

export interface SpriteSetDef {
  body: BodyLayerDef;
  legs: LegsLayerDef;
}

export type LoadedBodyLayer = Partial<Record<BodyAnimName, PIXI.Texture[]>>;
export type LoadedLegsLayer = Partial<Record<LegsAnimName, PIXI.Texture[]>>;

export interface LoadedSpriteSet {
  body: LoadedBodyLayer;
  legs: LoadedLegsLayer;
}

// Build a per-type spec that points each layer to its respective subfolder.
// fps/spriteScale defaults are shared between the two layers so they stay in
// lock-step (frame dimensions must match for the shared anchor to make sense).
function makeTypeDefs(tribe: Tribe, folder: string): SpriteSetDef {
  const base = `/sprites/${tribe}/${folder}`;
  return {
    body: {
      idle:   { path: `${base}/body/idle.png`,   fps: 20, spriteScale: 4.8 },
      walk:   { path: `${base}/body/walk.png`,   fps: 32, spriteScale: 4.8 },
      attack: { path: `${base}/body/attack.png`, fps: 30, spriteScale: 4.8 },
      carry:  { path: `${base}/body/carry.png`,  fps: 24, spriteScale: 4.8 },
      throw:  { path: `${base}/body/throw.png`,  fps: 24, spriteScale: 4.8 },
    },
    legs: {
      idle:   { path: `${base}/legs/idle.png`,   fps: 20, spriteScale: 4.8 },
      walk:   { path: `${base}/legs/walk.png`,   fps: 32, spriteScale: 4.8 },
    },
  };
}

// ── Per-tribe sprite registry ────────────────────────────────────────────────
// AUTO-GENERATED from each tribe's roster (gameConfig character block keys):
// every roster type gets convention-based paths /sprites/<tribe>/<type>/… (the
// config block's `spriteFolder` overrides the folder name when the asset dir
// differs, e.g. Lapinor's capitalised 'Sniper'). A type whose sheets are
// missing simply falls back to Graphics rendering — so adding a character in
// gameConfig needs no registry edit: drop the PNGs in and they're picked up.
const SPRITE_DEFS: Partial<Record<Tribe, Partial<Record<string, SpriteSetDef>>>> = {};
for (const tribe of Object.keys(TRIBE_ROSTERS) as Tribe[]) {
  const defs: Partial<Record<string, SpriteSetDef>> = {};
  for (const type of TRIBE_ROSTERS[tribe]) {
    defs[type] = makeTypeDefs(tribe, charSpriteFolder(tribe, type));
  }
  SPRITE_DEFS[tribe] = defs;
}

function bodyDefFor(tribe: Tribe, type: string, anim: BodyAnimName): SpriteLayerAnimDef | undefined {
  return SPRITE_DEFS[tribe]?.[type]?.body[anim];
}
function legsDefFor(tribe: Tribe, type: string, anim: LegsAnimName): SpriteLayerAnimDef | undefined {
  return SPRITE_DEFS[tribe]?.[type]?.legs[anim];
}

export function getBodyAnimFps(tribe: Tribe, type: string, anim: BodyAnimName): number {
  return bodyDefFor(tribe, type, anim)?.fps ?? 10;
}
export function getBodySpriteScale(tribe: Tribe, type: string, anim: BodyAnimName): number {
  return bodyDefFor(tribe, type, anim)?.spriteScale ?? 1.0;
}
export function getBodyFeetAnchorY(tribe: Tribe, type: string, anim: BodyAnimName): number {
  return bodyDefFor(tribe, type, anim)?.feetAnchorY ?? 1.0;
}
export function getLegsAnimFps(tribe: Tribe, type: string, anim: LegsAnimName): number {
  return legsDefFor(tribe, type, anim)?.fps ?? 10;
}
export function getLegsSpriteScale(tribe: Tribe, type: string, anim: LegsAnimName): number {
  return legsDefFor(tribe, type, anim)?.spriteScale ?? 1.0;
}
export function getLegsFeetAnchorY(tribe: Tribe, type: string, anim: LegsAnimName): number {
  return legsDefFor(tribe, type, anim)?.feetAnchorY ?? 1.0;
}

// Pixels to inset the source rectangle on each side. PIXI's linear texture
// sampler reads half a pixel past the rectangle edge, so without an inset the
// top/bottom of one frame picks up content from the adjacent row (visible as
// "ghost" pixels above the character's head).
const FRAME_INSET_PX = 2;

function extractFrames(texture: PIXI.Texture, frameCount: number, fw: number, fh: number): PIXI.Texture[] {
  const frames: PIXI.Texture[] = [];
  for (let i = 0; i < frameCount; i++) {
    const r = Math.floor(i / FRAMES_PER_ROW);
    const c = i % FRAMES_PER_ROW;
    frames.push(new PIXI.Texture(
      texture.baseTexture,
      new PIXI.Rectangle(
        c * fw + FRAME_INSET_PX,
        r * fh + FRAME_INSET_PX,
        fw - 2 * FRAME_INSET_PX,
        fh - 2 * FRAME_INSET_PX,
      ),
    ));
  }
  return frames;
}

/**
 * One probe pass over a sheet: the frame count (index of the first cell whose
 * fill ratio is below MIN_CELL_FILL_RATIO — a simple "any non-zero alpha"
 * check is too sensitive, stray export artifacts flag unused cells as filled)
 * plus each filled cell's alpha bounding box in SOURCE px, padded by
 * BBOX_MARGIN_PROBE probe px because nearest sampling can skip thin edges.
 */
const ALPHA_THRESHOLD     = 32;     // pixel must be > this to count as "drawn"
const MIN_CELL_FILL_RATIO = 0.001;  // >= 0.1 % of sampled pixels above threshold

// Probe resolution per grid cell. The source frames are far larger than needed
// to answer "does this cell contain art, and where?", so we downscale the whole
// sheet onto a tiny canvas (PROBE_CELL px per cell) and do a SINGLE readback.
// This replaces the old per-cell full-resolution getImageData calls (one 2.5 MB
// readback per cell × 112 sheets) with one ~tens-of-KB readback per sheet —
// the bulk of the loader's main-thread cost.
//
// Downscaling uses NEAREST-neighbour (imageSmoothing off): bilinear averaging
// dilutes thin shapes (e.g. legs) below ALPHA_THRESHOLD and makes filled cells
// read as empty. Nearest preserves peak alpha and introduces no cross-cell bleed,
// so we can sample the full cell exactly like the original full-res scan did.
const PROBE_CELL        = 128;  // 4 source px per probe px on 512-px cells: bbox granularity vs readback/scan cost
const BBOX_MARGIN_PROBE = 1;    // probe px (= one sampling stride) added around each box — nearest sampling can skip at most one stride

interface SheetProbe {
  frameCount: number;
  boxes:      PIXI.Rectangle[];  // per frame, relative to the cell's top-left, source px
}

function probeSheet(texture: PIXI.Texture, rows: number, fw: number, fh: number): SheetProbe | null {
  const source = (texture.baseTexture.resource as { source?: CanvasImageSource }).source;
  if (!source) return null;  // can't introspect

  const cols   = FRAMES_PER_ROW;
  const probeW = cols * PROBE_CELL;
  const probeH = rows * PROBE_CELL;

  const canvas = document.createElement('canvas');
  canvas.width  = probeW;
  canvas.height = probeH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;  // nearest-neighbour — preserve peak alpha
  // Downscale the entire sheet in one draw, then read it back once.
  ctx.drawImage(source, 0, 0, texture.width, texture.height, 0, 0, probeW, probeH);
  const data = ctx.getImageData(0, 0, probeW, probeH).data;
  canvas.width = canvas.height = 0;  // release the backing store now

  const sx = fw / PROBE_CELL, sy = fh / PROBE_CELL;  // source px per probe px
  const boxes: PIXI.Rectangle[] = [];
  const total = rows * cols;
  for (let i = 0; i < total; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x0 = c * PROBE_CELL, x1 = (c + 1) * PROBE_CELL;
    const y0 = r * PROBE_CELL, y1 = (r + 1) * PROBE_CELL;
    let filled = 0, sampled = 0;
    let minX = x1, maxX = x0 - 1, minY = y1, maxY = y0 - 1;
    for (let y = y0; y < y1; y++) {
      let idx = (y * probeW + x0) * 4 + 3;  // alpha byte of (x0, y)
      for (let x = x0; x < x1; x++) {
        if (data[idx] > ALPHA_THRESHOLD) {
          filled++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        sampled++;
        idx += 4;
      }
    }
    if (filled / sampled < MIN_CELL_FILL_RATIO) return { frameCount: i, boxes };
    // Probe → source px, padded, clamped to the cell.
    const bx0 = Math.max(0,  Math.floor((minX - x0 - BBOX_MARGIN_PROBE) * sx));
    const by0 = Math.max(0,  Math.floor((minY - y0 - BBOX_MARGIN_PROBE) * sy));
    const bx1 = Math.min(fw, Math.ceil ((maxX - x0 + 1 + BBOX_MARGIN_PROBE) * sx));
    const by1 = Math.min(fh, Math.ceil ((maxY - y0 + 1 + BBOX_MARGIN_PROBE) * sy));
    boxes.push(new PIXI.Rectangle(bx0, by0, bx1 - bx0, by1 - by0));
  }
  return { frameCount: total, boxes };
}

// ── Atlas repack ──────────────────────────────────────────────────────────────
// Art covers only ~23 % of each sheet cell (the rest is transparent padding),
// and a 512-px frame is far more than a character ever renders at — so keeping
// the raw sheet resident costs ~24–36 MB decoded per animation. After a sheet
// loads we draw just the probed boxes, scaled down to the largest size the
// current render resolution can show, into one tight atlas, hand out PIXI
// *trimmed* textures whose `orig`/`trim` still describe the full cell (anchor
// and scale maths in Character are untouched), and unload the source sheet.
const REPACK_SHEETS         = true;
const ATLAS_MAX_WIDTH       = 4096;   // shelf-pack row width
const ATLAS_MAX_HEIGHT      = 4096;   // conservative WebGL max — fall back to the raw sheet beyond this
const ATLAS_PAD             = 2;      // px gap between packed frames (sampler bleed guard)
const ATLAS_SCALE_HEADROOM  = 1.25;   // keep ≥ 1.25 texels per rendered px before shrinking
// GPU-only atlases: upload each atlas as soon as it's packed and close its
// bitmap, so the GL texture is the only copy (VRAM on a hardware GPU). Off by
// default: in a software-GL / automation Chrome the GL copy lives in system
// memory too and the churn measured *worse*, and it can't be verified from
// inside the page. Trial it on a real GPU with Chrome's task manager (GPU
// memory column) before enabling; AtlasResource rebuilds evicted atlases from
// their sheets when it's on.
const ATLAS_GPU_ONLY = false;

/** Largest scale (≤ 1) a frame of height `fh` needs so it still renders with
 *  ATLAS_SCALE_HEADROOM texels per device pixel at the current resolution. */
function atlasScaleFor(tribe: Tribe, type: string, animDef: SpriteLayerAnimDef, fh: number): number {
  const renderedPx = charConfig(tribe, type).height * animDef.spriteScale * GAME_ZOOM * getRenderScale();
  return Math.min(1, (renderedPx * ATLAS_SCALE_HEADROOM) / fh);
}

interface PackedAtlas {
  base:   PIXI.BaseTexture;
  frames: PIXI.Texture[];
}

interface AtlasLayout {
  place:  PIXI.Rectangle[];  // per frame, atlas px
  width:  number;
  height: number;
}

/** Shelf-pack the probed boxes (tallest first) at `scale`. Null when the
 *  atlas would exceed the size cap — caller falls back to the raw sheet. */
function layoutAtlas(probe: SheetProbe, scale: number): AtlasLayout | null {
  const n     = probe.frameCount;
  const order = [...Array(n).keys()].sort((a, b) => probe.boxes[b].height - probe.boxes[a].height);
  const place: PIXI.Rectangle[] = new Array(n);
  let x = 0, y = 0, rowH = 0, width = 0;
  for (const i of order) {
    const b  = probe.boxes[i];
    const sw = Math.max(1, Math.round(b.width  * scale));
    const sh = Math.max(1, Math.round(b.height * scale));
    if (x > 0 && x + sw > ATLAS_MAX_WIDTH) { x = 0; y += rowH + ATLAS_PAD; rowH = 0; }
    place[i] = new PIXI.Rectangle(x, y, sw, sh);
    x += sw + ATLAS_PAD;
    if (sh > rowH) rowH = sh;
    if (x > width) width = x;
  }
  const height = y + rowH;
  if (height > ATLAS_MAX_HEIGHT || width === 0) return null;
  return { place, width, height };
}

/** Draw the boxes of `source` (the raw sheet) into a fresh atlas bitmap. */
async function drawAtlas(
  source: CanvasImageSource, probe: SheetProbe, layout: AtlasLayout, fw: number, fh: number, scale: number,
): Promise<ImageBitmap> {
  const canvas = document.createElement('canvas');
  canvas.width  = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('[sprites] 2d context unavailable');
  ctx.imageSmoothingEnabled = scale < 1;
  ctx.imageSmoothingQuality = 'high';
  for (let i = 0; i < probe.frameCount; i++) {
    const b = probe.boxes[i], d = layout.place[i];
    const cx = (i % FRAMES_PER_ROW) * fw, cy = Math.floor(i / FRAMES_PER_ROW) * fh;
    ctx.drawImage(source, cx + b.x, cy + b.y, b.width, b.height, d.x, d.y, d.width, d.height);
  }
  // Same construction as PIXI's own loader (bitmap + default alphaMode) so the
  // edge-alpha pipeline is unchanged.
  try {
    return await createImageBitmap(canvas);
  } finally {
    canvas.width = canvas.height = 0;
  }
}

/** Fetch + decode a sheet outside the Assets cache — used only to rebuild an
 *  atlas whose bitmap was released (context loss, texture GC). */
async function loadSheetBitmap(path: string): Promise<ImageBitmap> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`[sprites] ${path}: HTTP ${res.status}`);
  return createImageBitmap(await res.blob());
}

/**
 * Atlas texture resource. With ATLAS_GPU_ONLY off it behaves like a plain
 * owned ImageBitmapResource (bitmap kept; PIXI re-uploads from it after a
 * texture-GC eviction or context restore). With it on, the bitmap is closed as
 * soon as it has been uploaded, and if the GL texture is ever needed again
 * (context restore, texture GC after TEXTURE_GC_IDLE_SEC) the atlas is rebuilt
 * from the source sheet via `rebuild` and re-uploaded — PIXI binds a blank
 * texture meanwhile, so those frames are invisible for a few frames.
 */
// 0×0 stand-in for a released bitmap (ImageBitmapResource.EMPTY is private).
const RELEASED_SOURCE = document.createElement('canvas');
RELEASED_SOURCE.width = RELEASED_SOURCE.height = 0;

/** Lifetime counters for the dev perf panel (TEX row tooltip). */
const atlasStats = { uploads: 0, releases: 0, rebuilds: 0 };
export function spriteAtlasStats(): Readonly<typeof atlasStats> { return atlasStats; }

// Renderer used (only with ATLAS_GPU_ONLY) to push each freshly packed atlas
// to the GPU right away; Game registers it once.
let spriteRenderer: PIXI.Renderer | null = null;
export function setSpriteRenderer(renderer: PIXI.IRenderer | null): void {
  spriteRenderer = renderer && 'texture' in renderer ? (renderer as PIXI.Renderer) : null;
}
function eagerUpload(base: PIXI.BaseTexture): void {
  if (!ATLAS_GPU_ONLY || !spriteRenderer || spriteRenderer.context.isLost) return;
  spriteRenderer.texture.bind(base);
  spriteRenderer.texture.unbind(base);
}

class AtlasResource extends PIXI.ImageBitmapResource {
  private rebuilding: Promise<void> | null = null;

  constructor(bitmap: ImageBitmap, private readonly rebuild: () => Promise<ImageBitmap>) {
    super(bitmap, { ownsImageBitmap: true });
  }

  override upload(renderer: PIXI.Renderer, baseTexture: PIXI.BaseTexture, glTexture: PIXI.GLTexture): boolean {
    if (!(this.source instanceof ImageBitmap)) {
      this.startRebuild();
      return false;   // blank until update() bumps dirtyId with the rebuilt bitmap
    }
    const ok = super.upload(renderer, baseTexture, glTexture);
    if (ok) atlasStats.uploads++;
    if (ok && ATLAS_GPU_ONLY) {
      this.source.close();
      this.source = RELEASED_SOURCE;
      atlasStats.releases++;
    }
    return ok;
  }

  private startRebuild(): void {
    if (this.rebuilding) return;
    atlasStats.rebuilds++;
    this.rebuilding = this.rebuild()
      .then(bitmap => {
        if (this.destroyed) { bitmap.close(); return; }
        this.source = bitmap;
        this.update();
      })
      .catch(err => console.warn('[sprites] atlas rebuild failed', err))
      .finally(() => { this.rebuilding = null; });
  }
}

/** Repack one sheet: layout → atlas bitmap → trimmed frame textures. Returns
 *  null when the atlas would exceed the size cap — caller keeps the raw sheet. */
async function packFrames(
  texture: PIXI.Texture, path: string, probe: SheetProbe, fw: number, fh: number, scale: number,
): Promise<PackedAtlas | null> {
  const source = (texture.baseTexture.resource as { source?: CanvasImageSource }).source;
  if (!source) return null;
  const layout = layoutAtlas(probe, scale);
  if (!layout) return null;

  const bitmap  = await drawAtlas(source, probe, layout, fw, fh, scale);
  const rebuild = async () => {
    const sheet = await loadSheetBitmap(path);
    try { return await drawAtlas(sheet, probe, layout, fw, fh, scale); }
    finally { sheet.close(); }
  };
  const base = new PIXI.BaseTexture(new AtlasResource(bitmap, rebuild), {
    scaleMode: PIXI.SCALE_MODES.NEAREST,
    mipmap:    PIXI.MIPMAP_MODES.OFF,
  });
  eagerUpload(base);   // no-op unless ATLAS_GPU_ONLY

  // `orig` keeps the pre-existing inset cell size so spriteScale tuning holds;
  // `trim` places the box inside it; `frame` is where the (scaled) pixels live.
  const orig = new PIXI.Rectangle(0, 0, fw - 2 * FRAME_INSET_PX, fh - 2 * FRAME_INSET_PX);
  const frames: PIXI.Texture[] = [];
  for (let i = 0; i < probe.frameCount; i++) {
    const b = probe.boxes[i];
    const trim = new PIXI.Rectangle(b.x - FRAME_INSET_PX, b.y - FRAME_INSET_PX, b.width, b.height);
    frames.push(new PIXI.Texture(base, layout.place[i], orig, trim));
  }
  return { base, frames };
}

// Cache key combines tribe + type so the same character type can have different
// sheets per tribe.
const cache = new Map<string, LoadedSpriteSet | null>();
const cacheKey = (tribe: Tribe, type: string) => `${tribe}:${type}`;
// Atlas base textures per cached set — destroyed (bitmaps closed) on eviction.
const atlasBases = new Map<string, PIXI.BaseTexture[]>();

interface LoadedLayerAnim {
  frames: PIXI.Texture[];
  base:   PIXI.BaseTexture | null;   // repacked atlas, or null when the raw sheet stayed resident
}

/**
 * Load one (body|legs) animation: returns the extracted frame textures, or
 * null if the file is missing. Mipmaps are disabled per-texture to avoid
 * adjacent-frame bleed at smaller render sizes. When repacking succeeds the
 * source sheet is unloaded before returning; otherwise it stays in the Assets
 * cache and the frames reference it directly.
 */
async function loadLayerAnim(
  tribeId: Tribe,
  type:    string,
  layer:   'body' | 'legs',
  animName: string,
  animDef: SpriteLayerAnimDef,
): Promise<LoadedLayerAnim | null> {
  let texture: PIXI.Texture;
  try {
    texture = await PIXI.Assets.load<PIXI.Texture>(animDef.path);
  } catch {
    return null;
  }
  texture.baseTexture.mipmap    = PIXI.MIPMAP_MODES.OFF;
  texture.baseTexture.scaleMode = PIXI.SCALE_MODES.NEAREST;
  texture.baseTexture.update();
  const rows  = animDef.rows ?? Math.max(1, Math.round(texture.height / FRAME_HEIGHT_PX));
  const fw    = Math.floor(texture.width  / FRAMES_PER_ROW);
  const fh    = Math.floor(texture.height / rows);
  const probe = probeSheet(texture, rows, fw, fh);
  const frameCount = probe?.frameCount ?? rows * FRAMES_PER_ROW;

  if (REPACK_SHEETS && probe) {
    const scale  = atlasScaleFor(tribeId, type, animDef, fh);
    const packed = await packFrames(texture, animDef.path, probe, fw, fh, scale).catch(() => null);
    if (packed) {
      if (DEBUG_SPRITES) console.log(`[sprites] ${tribeId}/${type}/${layer}/${animName}: ${frameCount} frames → atlas ${packed.base.width}×${packed.base.height} @${scale.toFixed(2)} (sheet ${texture.width}×${texture.height})`);
      await PIXI.Assets.unload(animDef.path).catch(() => {});
      return packed;
    }
  }
  if (DEBUG_SPRITES) console.log(`[sprites] ${tribeId}/${type}/${layer}/${animName}: sheet ${texture.width}×${texture.height}, detected ${frameCount} frames in ${FRAMES_PER_ROW}×${rows} grid, frame ${fw}×${fh}`);
  return { frames: extractFrames(texture, frameCount, fw, fh), base: null };
}

/** A (tribe, type) pair identifying one character's sprite set. */
export interface SpriteSetKey { tribe: Tribe; type: string }

const inflight = new Map<string, Promise<LoadedSpriteSet | null>>();

/** Every sheet URL a type's def points at — the unit of Assets.load/unload. */
function sheetPaths(def: SpriteSetDef): string[] {
  return [...Object.values(def.body), ...Object.values(def.legs)].map(d => d.path);
}

/**
 * Load one type's sprite set (both layers) into the cache. Concurrent calls
 * for the same key share a single load; a key already in the cache resolves
 * immediately. Sheets are ~24–36 MB each once decoded, so callers should
 * request only the sets a match can actually field (see ensureSpriteSets).
 */
export function loadSpriteSet(tribe: Tribe, type: string): Promise<LoadedSpriteSet | null> {
  const key = cacheKey(tribe, type);
  if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null);
  const pending = inflight.get(key);
  if (pending) return pending;

  const def = SPRITE_DEFS[tribe]?.[type];
  if (!def) { cache.set(key, null); return Promise.resolve(null); }

  const task = (async () => {
    const body: LoadedBodyLayer = {};
    const legs: LoadedLegsLayer = {};
    const bases: PIXI.BaseTexture[] = [];
    let bodyLoaded = false;
    let legsLoaded = false;

    for (const [animName, animDef] of Object.entries(def.body) as [BodyAnimName, SpriteLayerAnimDef][]) {
      const anim = await loadLayerAnim(tribe, type, 'body', animName, animDef);
      if (anim && anim.frames.length > 0) { body[animName] = anim.frames; bodyLoaded = true; }
      if (anim?.base) bases.push(anim.base);
    }
    for (const [animName, animDef] of Object.entries(def.legs) as [LegsAnimName, SpriteLayerAnimDef][]) {
      const anim = await loadLayerAnim(tribe, type, 'legs', animName, animDef);
      if (anim && anim.frames.length > 0) { legs[animName] = anim.frames; legsLoaded = true; }
      if (anim?.base) bases.push(anim.base);
    }

    let result: LoadedSpriteSet | null = null;
    if (bodyLoaded && legsLoaded) {
      // Sanity check: layers should share frame dimensions (the shared anchor
      // and scale only line up if their cells are the same size). Warn if not.
      const probeBody = body.idle ?? body.walk ?? body.attack ?? body.carry;
      const probeLegs = legs.idle ?? legs.walk;
      if (probeBody && probeLegs) {
        const b = probeBody[0], l = probeLegs[0];
        if (b && l && (b.width !== l.width || b.height !== l.height)) {
          console.warn(`[sprites] ${tribe}/${type}: body frame ${b.width}×${b.height} differs from legs ${l.width}×${l.height} — anchor/scale assume matching dimensions`);
        }
      }
      result = { body, legs };
      atlasBases.set(key, bases);
    } else if (bodyLoaded || legsLoaded) {
      console.warn(`[sprites] ${tribe}/${type}: only ${bodyLoaded ? 'body' : 'legs'} loaded — falling back to Graphics`);
      // Drop the half that did load — a set that renders as Graphics has no
      // use for it.
      for (const b of bases) b.destroy();
      await PIXI.Assets.unload(sheetPaths(def)).catch(() => {});
    }
    cache.set(key, result);
    return result;
  })();

  inflight.set(key, task);
  // loadLayerAnim swallows its own errors, so `task` never rejects — but clear
  // the slot on both branches so a surprise never pins the key as in-flight.
  task.then(() => inflight.delete(key), () => inflight.delete(key));
  return task;
}

/** True once a set has been resolved either way (frames cached, or known to
 *  have no art → Graphics). False while unrequested or still loading. */
export function isSpriteSetReady(tribe: Tribe, type: string): boolean {
  return cache.has(cacheKey(tribe, type));
}

/** Load every listed set in parallel; resolves once all are cached. */
export async function ensureSpriteSets(keys: Iterable<SpriteSetKey>): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  for (const { tribe, type } of keys) tasks.push(loadSpriteSet(tribe, type));
  await Promise.all(tasks);
}

/**
 * Free every cached set NOT in `keep` — the frame textures, their repacked
 * atlases, and any raw sheet still in the Assets cache (fallback path). Call only
 * when no live Character still uses the evicted sets (i.e. after the scene
 * has been torn down for a map switch). Sets still loading are left alone;
 * they're evicted on the next call.
 */
export async function unloadSpriteSetsExcept(keep: Iterable<SpriteSetKey>): Promise<void> {
  const keepKeys = new Set<string>();
  for (const { tribe, type } of keep) keepKeys.add(cacheKey(tribe, type));

  const paths: string[] = [];
  for (const [key, set] of cache) {
    if (keepKeys.has(key) || inflight.has(key)) continue;
    cache.delete(key);
    if (!set) continue;
    for (const frames of [...Object.values(set.body), ...Object.values(set.legs)]) {
      for (const t of frames) t.destroy(false);
    }
    for (const b of atlasBases.get(key) ?? []) b.destroy();   // closes the atlas bitmaps
    atlasBases.delete(key);
    const [tribe, type] = key.split(':') as [Tribe, string];
    const def = SPRITE_DEFS[tribe]?.[type];
    if (def) paths.push(...sheetPaths(def));
  }
  if (paths.length > 0) await PIXI.Assets.unload(paths).catch(() => {});
}

/**
 * Returns the loaded sprite set for a tribe + character type, or null if none
 * is available. A set nobody asked for yet (e.g. a dev-panel spawn outside the
 * match's loadout) starts loading in the background so later spawns of that
 * type get their art; this first one renders as Graphics.
 */
export function getSpriteSet(tribe: Tribe, type: string): LoadedSpriteSet | null {
  const key = cacheKey(tribe, type);
  if (!cache.has(key)) {
    if (!inflight.has(key)) void loadSpriteSet(tribe, type);
    return null;
  }
  return cache.get(key) ?? null;
}

/** Approximate bytes of atlas texture memory held by resident sprite sets
 *  (RGBA, one copy). Dev perf panel. */
export function spriteTextureBytes(): number {
  let bytes = 0;
  const counted = new Set<PIXI.BaseTexture>();
  for (const [key, set] of cache) {
    if (!set) continue;
    for (const b of atlasBases.get(key) ?? []) { counted.add(b); bytes += b.realWidth * b.realHeight * 4; }
    // Fallback path: frames still reference the raw sheet.
    for (const frames of [...Object.values(set.body), ...Object.values(set.legs)]) {
      const b = frames[0]?.baseTexture;
      if (b && !counted.has(b)) { counted.add(b); bytes += b.realWidth * b.realHeight * 4; }
    }
  }
  return bytes;
}
