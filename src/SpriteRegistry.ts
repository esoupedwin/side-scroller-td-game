import * as PIXI from 'pixi.js';
import type { Tribe } from './Tribes';

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
const FRAME_HEIGHT_PX = 800;

export interface SpriteLayerAnimDef {
  path:        string;  // URL served from /public, e.g. '/sprites/tomaro/warrior/body/walk.png'
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
function makeTypeDefs(tribe: Tribe, type: string): SpriteSetDef {
  const base = `/sprites/${tribe}/${type}`;
  return {
    body: {
      idle:   { path: `${base}/body/idle.png`,   fps: 20, spriteScale: 4.0 },
      walk:   { path: `${base}/body/walk.png`,   fps: 32, spriteScale: 4.0 },
      attack: { path: `${base}/body/attack.png`, fps: 30, spriteScale: 4.0 },
      carry:  { path: `${base}/body/carry.png`,  fps: 24, spriteScale: 4.0 },
      throw:  { path: `${base}/body/throw.png`,  fps: 24, spriteScale: 4.0 },
    },
    legs: {
      idle:   { path: `${base}/legs/idle.png`,   fps: 20, spriteScale: 4.0 },
      walk:   { path: `${base}/legs/walk.png`,   fps: 32, spriteScale: 4.0 },
    },
  };
}

// ── Per-tribe sprite registry ────────────────────────────────────────────────
// Each tribe maps character type → layered animation metadata. A type with no
// entry (or one whose layered assets fail to load) falls back to Graphics
// rendering. Add new tribes here as their sheets are produced.
const SPRITE_DEFS: Partial<Record<Tribe, Partial<Record<string, SpriteSetDef>>>> = {
  tomaro: {
    conscript: makeTypeDefs('tomaro', 'conscript'),
    warrior:   makeTypeDefs('tomaro', 'warrior'),
    rifleman:  makeTypeDefs('tomaro', 'rifleman'),
    archer:    makeTypeDefs('tomaro', 'archer'),
    rocketeer: makeTypeDefs('tomaro', 'rocketeer'),
    grenadier: makeTypeDefs('tomaro', 'grenadier'),
  },
  meowee: {
    conscript: makeTypeDefs('meowee', 'conscript'),
    warrior:   makeTypeDefs('meowee', 'warrior'),
    rifleman:  makeTypeDefs('meowee', 'rifleman'),
    archer:    makeTypeDefs('meowee', 'archer'),
    rocketeer: makeTypeDefs('meowee', 'rocketeer'),
    grenadier: makeTypeDefs('meowee', 'grenadier'),
  },
};

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
 * Scan the grid left-to-right, top-to-bottom and return the index of the first
 * cell whose fill ratio is below MIN_CELL_FILL_RATIO — that's the actual frame
 * count. A simple "any non-zero alpha" check is too sensitive (stray export
 * artifacts in unused cells flag them as filled), so we require enough sampled
 * pixels to have meaningful alpha.
 */
const ALPHA_THRESHOLD     = 32;     // pixel must be > this to count as "drawn"
const MIN_CELL_FILL_RATIO = 0.001;  // >= 0.1 % of sampled pixels above threshold

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

/**
 * Load one (body|legs) animation: returns the extracted frame textures, or
 * null if the file is missing. Mipmaps are disabled per-texture to avoid
 * adjacent-frame bleed at smaller render sizes.
 */
async function loadLayerAnim(
  tribeId: Tribe,
  type:    string,
  layer:   'body' | 'legs',
  animName: string,
  animDef: SpriteLayerAnimDef,
): Promise<PIXI.Texture[] | null> {
  try {
    const texture    = await PIXI.Assets.load<PIXI.Texture>(animDef.path);
    texture.baseTexture.mipmap    = PIXI.MIPMAP_MODES.OFF;
    texture.baseTexture.scaleMode = PIXI.SCALE_MODES.NEAREST;
    texture.baseTexture.update();
    const rows       = animDef.rows ?? Math.max(1, Math.round(texture.height / FRAME_HEIGHT_PX));
    const fw         = Math.floor(texture.width  / FRAMES_PER_ROW);
    const fh         = Math.floor(texture.height / rows);
    const frameCount = detectFrameCount(texture, rows, fw, fh);
    console.log(`[sprites] ${tribeId}/${type}/${layer}/${animName}: sheet ${texture.width}×${texture.height}, detected ${frameCount} frames in ${FRAMES_PER_ROW}×${rows} grid, frame ${fw}×${fh}`);
    return extractFrames(texture, frameCount, fw, fh);
  } catch {
    return null;
  }
}

export async function preloadAllSprites(): Promise<void> {
  const tasks: Promise<void>[] = [];
  for (const [tribeId, typeDefs] of Object.entries(SPRITE_DEFS) as [Tribe, Partial<Record<string, SpriteSetDef>>][]) {
    if (!typeDefs) continue;
    for (const [type, def] of Object.entries(typeDefs)) {
      if (!def) { cache.set(cacheKey(tribeId, type), null); continue; }
      tasks.push((async () => {
        const body: LoadedBodyLayer = {};
        const legs: LoadedLegsLayer = {};
        let bodyLoaded = false;
        let legsLoaded = false;

        for (const [animName, animDef] of Object.entries(def.body) as [BodyAnimName, SpriteLayerAnimDef][]) {
          const frames = await loadLayerAnim(tribeId, type, 'body', animName, animDef);
          if (frames && frames.length > 0) { body[animName] = frames; bodyLoaded = true; }
        }
        for (const [animName, animDef] of Object.entries(def.legs) as [LegsAnimName, SpriteLayerAnimDef][]) {
          const frames = await loadLayerAnim(tribeId, type, 'legs', animName, animDef);
          if (frames && frames.length > 0) { legs[animName] = frames; legsLoaded = true; }
        }

        if (bodyLoaded && legsLoaded) {
          // Sanity check: layers should share frame dimensions (the shared anchor
          // and scale only line up if their cells are the same size). Warn if not.
          const probeBody = body.idle ?? body.walk ?? body.attack ?? body.carry;
          const probeLegs = legs.idle ?? legs.walk;
          if (probeBody && probeLegs) {
            const b = probeBody[0], l = probeLegs[0];
            if (b && l && (b.width !== l.width || b.height !== l.height)) {
              console.warn(`[sprites] ${tribeId}/${type}: body frame ${b.width}×${b.height} differs from legs ${l.width}×${l.height} — anchor/scale assume matching dimensions`);
            }
          }
          cache.set(cacheKey(tribeId, type), { body, legs });
        } else if (bodyLoaded || legsLoaded) {
          console.warn(`[sprites] ${tribeId}/${type}: only ${bodyLoaded ? 'body' : 'legs'} loaded — falling back to Graphics`);
          cache.set(cacheKey(tribeId, type), null);
        } else {
          cache.set(cacheKey(tribeId, type), null);
        }
      })());
    }
  }
  await Promise.all(tasks);
}

/** Returns the loaded sprite set for a tribe + character type, or null if none is available. */
export function getSpriteSet(tribe: Tribe, type: string): LoadedSpriteSet | null {
  return cache.get(cacheKey(tribe, type)) ?? null;
}
