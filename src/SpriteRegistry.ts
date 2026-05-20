import * as PIXI from 'pixi.js';
import type { Tribe } from './Tribes';

export type AnimationName = 'idle' | 'walk' | 'attack' | 'attackWalk' | 'carry';

// Sprite sheets are laid out left-to-right, top-to-bottom, with exactly
// FRAMES_PER_ROW frames per row. Frame height is fixed by artist convention
// (FRAME_HEIGHT_PX); row count is derived from the sheet's height. The actual
// frame count within the grid is detected from the image (trailing empty cells
// in the last row are skipped).
const FRAMES_PER_ROW = 6;
const FRAME_HEIGHT_PX = 600;

export interface SpriteAnimDef {
  path:        string;  // URL served from /public, e.g. '/sprites/tomaro/warrior/walk.png'
  fps:         number;  // desired playback speed in frames per second
  spriteScale: number;  // height = config.height * spriteScale (compensates for frame padding)
  feetAnchorY?: number; // 0..1; where in the frame the character's feet sit (default 1 = bottom edge).
                        // Lower this when the art has empty padding below the character.
  rows?:       number;  // optional override; auto-derived from sheet.height / FRAME_HEIGHT_PX otherwise.
}

export type SpriteSetDef    = Partial<Record<AnimationName, SpriteAnimDef>>;
export type LoadedSpriteSet = Partial<Record<AnimationName, PIXI.Texture[]>>;

// Build a per-type spec where every animation uses the same path prefix.
// Keeps tribe entries below from being a wall of duplication.
function makeTypeDefs(tribe: Tribe, type: string): SpriteSetDef {
  const base = `/sprites/${tribe}/${type}`;
  return {
    idle:   { path: `${base}/idle.png`,   fps: 20, spriteScale: 4.0 },
    walk:   { path: `${base}/walk.png`,   fps: 32, spriteScale: 4.0 },
    attack: { path: `${base}/attack.png`, fps: 30, spriteScale: 4.0 },
    carry:  { path: `${base}/carry.png`,  fps: 24, spriteScale: 4.0 },
  };
}

// ── Per-tribe sprite registry ────────────────────────────────────────────────
// Each tribe maps character type → animation sheet metadata. A missing entry
// (whole tribe or specific type) falls back to Graphics rendering. Add new
// tribes here as their sheets are produced.
const SPRITE_DEFS: Partial<Record<Tribe, Partial<Record<string, SpriteSetDef>>>> = {
  tomaro: {
    conscript: makeTypeDefs('tomaro', 'conscript'),
    warrior:   makeTypeDefs('tomaro', 'warrior'),
    rifleman:  makeTypeDefs('tomaro', 'rifleman'),
    archer:    makeTypeDefs('tomaro', 'archer'),
    rocketeer: makeTypeDefs('tomaro', 'rocketeer'),
  },
  meowee: {
    conscript: makeTypeDefs('meowee', 'conscript'),
    warrior:   makeTypeDefs('meowee', 'warrior'),
    rifleman:  makeTypeDefs('meowee', 'rifleman'),
    archer:    makeTypeDefs('meowee', 'archer'),
    rocketeer: makeTypeDefs('meowee', 'rocketeer'),
  },
};

function defFor(tribe: Tribe, type: string, anim: AnimationName): SpriteAnimDef | undefined {
  return SPRITE_DEFS[tribe]?.[type]?.[anim];
}

export function getAnimFps(tribe: Tribe, type: string, anim: AnimationName): number {
  return defFor(tribe, type, anim)?.fps ?? 10;
}

export function getSpriteScale(tribe: Tribe, type: string, anim: AnimationName): number {
  return defFor(tribe, type, anim)?.spriteScale ?? 1.0;
}

export function getFeetAnchorY(tribe: Tribe, type: string, anim: AnimationName): number {
  return defFor(tribe, type, anim)?.feetAnchorY ?? 1.0;
}

// Pixels to inset the source rectangle on each side. PIXI's linear texture
// sampler reads half a pixel past the rectangle edge, so without an inset the
// top/bottom of one frame picks up content from the adjacent row (visible as
// "ghost" pixels above the character's head).
const FRAME_INSET_PX = 1;

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
 * Scan the grid left-to-right, top-to-bottom and return the index of the first
 * cell whose fill ratio is below MIN_CELL_FILL_RATIO — that's the actual frame
 * count. A simple "any non-zero alpha" check is too sensitive (stray export
 * artifacts in unused cells flag them as filled), so we require enough sampled
 * pixels to have meaningful alpha.
 */
const ALPHA_THRESHOLD     = 32;     // pixel must be > this to count as "drawn"
const MIN_CELL_FILL_RATIO = 0.01;   // >= 1 % of sampled pixels above threshold

function detectFrameCount(
  texture: PIXI.Texture,
  rows: number,
  fw: number,
  fh: number,
): number {
  const source = (texture.baseTexture.resource as { source?: CanvasImageSource }).source;
  if (!source) return rows * FRAMES_PER_ROW;  // can't introspect — assume full grid

  const canvas = document.createElement('canvas');
  canvas.width  = texture.width;
  canvas.height = texture.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return rows * FRAMES_PER_ROW;
  ctx.drawImage(source, 0, 0);

  const total = rows * FRAMES_PER_ROW;
  for (let i = 0; i < total; i++) {
    const c = i % FRAMES_PER_ROW;
    const r = Math.floor(i / FRAMES_PER_ROW);
    const data = ctx.getImageData(c * fw, r * fh, fw, fh).data;
    let filled = 0;
    const sampledPixels = data.length / 4;
    for (let j = 3; j < data.length; j += 4) {
      if (data[j] > ALPHA_THRESHOLD) filled++;
    }
    if (filled / sampledPixels < MIN_CELL_FILL_RATIO) return i;
  }
  return total;
}

// Cache key combines tribe + type so the same character type can have different
// sheets per tribe.
const cache = new Map<string, LoadedSpriteSet | null>();
const cacheKey = (tribe: Tribe, type: string) => `${tribe}:${type}`;

export async function preloadAllSprites(): Promise<void> {
  const tasks: Promise<void>[] = [];
  for (const [tribeId, typeDefs] of Object.entries(SPRITE_DEFS) as [Tribe, Partial<Record<string, SpriteSetDef>>][]) {
    if (!typeDefs) continue;
    for (const [type, def] of Object.entries(typeDefs)) {
      if (!def) { cache.set(cacheKey(tribeId, type), null); continue; }
      tasks.push((async () => {
        const result: LoadedSpriteSet = {};
        let anyLoaded = false;
        for (const [animName, animDef] of Object.entries(def) as [AnimationName, SpriteAnimDef][]) {
          try {
            const texture    = await PIXI.Assets.load<PIXI.Texture>(animDef.path);
            // Disable mipmaps: PIXI generates downscaled levels and blends across
            // frame boundaries, so neighboring frames bleed in when the sprite is
            // rendered smaller than its source (which is the common case for our
            // 512x600 frames). Without mipmaps, the inset rectangle below is
            // sufficient to keep adjacent frames out of the sample.
            texture.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
            texture.baseTexture.update();
            // Row count is derived from the sheet height (artist convention: FRAME_HEIGHT_PX per row),
            // unless the def explicitly overrides it.
            const rows       = animDef.rows ?? Math.max(1, Math.round(texture.height / FRAME_HEIGHT_PX));
            const fw         = Math.floor(texture.width  / FRAMES_PER_ROW);
            const fh         = Math.floor(texture.height / rows);
            const frameCount = detectFrameCount(texture, rows, fw, fh);
            console.log(`[sprites] ${tribeId}/${type}/${animName}: sheet ${texture.width}×${texture.height}, detected ${frameCount} frames in ${FRAMES_PER_ROW}×${rows} grid, frame ${fw}×${fh}`);
            result[animName] = extractFrames(texture, frameCount, fw, fh);
            anyLoaded = true;
          } catch {
            // sprite file not present — silently fall back to Graphics for this animation
          }
        }
        cache.set(cacheKey(tribeId, type), anyLoaded ? result : null);
      })());
    }
  }
  await Promise.all(tasks);
}

/** Returns the loaded sprite set for a tribe + character type, or null if none is available. */
export function getSpriteSet(tribe: Tribe, type: string): LoadedSpriteSet | null {
  return cache.get(cacheKey(tribe, type)) ?? null;
}
