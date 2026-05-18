import * as PIXI from 'pixi.js';

export type AnimationName = 'idle' | 'walk' | 'attack' | 'attackWalk' | 'carry';

// Sprite sheets are laid out left-to-right, top-to-bottom, with exactly
// FRAMES_PER_ROW frames per row. Frame width = sheet.width / FRAMES_PER_ROW.
// Frame height = sheet.height / rows. The actual frame count within the grid
// is detected from the image (trailing empty cells in the last row are skipped).
const FRAMES_PER_ROW = 6;

export interface SpriteAnimDef {
  path:        string;  // URL served from /public, e.g. '/sprites/conscript/walk.png'
  rows:        number;  // number of rows in the sheet (frames-per-row is fixed at FRAMES_PER_ROW)
  fps:         number;  // desired playback speed in frames per second
  spriteScale: number;  // height = config.height * spriteScale (compensates for frame padding)
  feetAnchorY?: number; // 0..1; where in the frame the character's feet sit (default 1 = bottom edge).
                        // Lower this when the art has empty padding below the character.
}

export type SpriteSetDef    = Partial<Record<AnimationName, SpriteAnimDef>>;
export type LoadedSpriteSet = Partial<Record<AnimationName, PIXI.Texture[]>>;

// ── Add entries here when sprite files are placed in /public/sprites/<type>/ ──
const SPRITE_DEFS: Partial<Record<string, SpriteSetDef>> = {
  conscript: {
    idle:   { path: '/sprites/conscript/idle.png',   rows: 6, fps: 20, spriteScale: 4.0 },
    walk:   { path: '/sprites/conscript/walk.png',   rows: 6, fps: 28, spriteScale: 4.0 },
    attack: { path: '/sprites/conscript/attack.png', rows: 6, fps: 30, spriteScale: 4.0 },
    carry:  { path: '/sprites/conscript/carry.png',  rows: 6, fps: 24, spriteScale: 4.0 },
  },
  warrior: {
    idle:   { path: '/sprites/warrior/idle.png',   rows: 6, fps: 20, spriteScale: 4.0 },
    walk:   { path: '/sprites/warrior/walk.png',   rows: 6, fps: 28, spriteScale: 4.0 },
    attack: { path: '/sprites/warrior/attack.png', rows: 6, fps: 30, spriteScale: 4.0 },
    carry:  { path: '/sprites/warrior/carry.png',  rows: 6, fps: 24, spriteScale: 4.0 },
  },
  rifleman: {
    idle:   { path: '/sprites/rifleman/idle.png',   rows: 6, fps: 20, spriteScale: 4.0 },
    walk:   { path: '/sprites/rifleman/walk.png',   rows: 6, fps: 28, spriteScale: 4.0 },
    attack: { path: '/sprites/rifleman/attack.png', rows: 6, fps: 30, spriteScale: 4.0 },
    carry:  { path: '/sprites/rifleman/carry.png',  rows: 6, fps: 24, spriteScale: 4.0 },
  },
};

export function getAnimFps(type: string, anim: AnimationName): number {
  return SPRITE_DEFS[type]?.[anim]?.fps ?? 10;
}

export function getSpriteScale(type: string, anim: AnimationName): number {
  return SPRITE_DEFS[type]?.[anim]?.spriteScale ?? 1.0;
}

export function getFeetAnchorY(type: string, anim: AnimationName): number {
  return SPRITE_DEFS[type]?.[anim]?.feetAnchorY ?? 1.0;
}

function extractFrames(texture: PIXI.Texture, frameCount: number, fw: number, fh: number): PIXI.Texture[] {
  const frames: PIXI.Texture[] = [];
  for (let i = 0; i < frameCount; i++) {
    const r = Math.floor(i / FRAMES_PER_ROW);
    const c = i % FRAMES_PER_ROW;
    frames.push(new PIXI.Texture(
      texture.baseTexture,
      new PIXI.Rectangle(c * fw, r * fh, fw, fh),
    ));
  }
  return frames;
}

/**
 * Scan the grid left-to-right, top-to-bottom and return the index of the first
 * fully-transparent cell — that's the actual frame count. Lets the author add
 * or remove frames without updating SPRITE_DEFS, as long as `rows` is right.
 */
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
    let hasContent = false;
    for (let j = 3; j < data.length; j += 4) {
      if (data[j] > 0) { hasContent = true; break; }
    }
    if (!hasContent) return i;
  }
  return total;
}

const cache = new Map<string, LoadedSpriteSet | null>();

export async function preloadAllSprites(): Promise<void> {
  await Promise.all(
    Object.entries(SPRITE_DEFS).map(async ([type, def]) => {
      if (!def) { cache.set(type, null); return; }
      const result: LoadedSpriteSet = {};
      let anyLoaded = false;
      for (const [animName, animDef] of Object.entries(def) as [AnimationName, SpriteAnimDef][]) {
        try {
          const texture    = await PIXI.Assets.load<PIXI.Texture>(animDef.path);
          const fw         = Math.floor(texture.width  / FRAMES_PER_ROW);
          const fh         = Math.floor(texture.height / animDef.rows);
          const frameCount = detectFrameCount(texture, animDef.rows, fw, fh);
          console.log(`[sprites] ${type}/${animName}: sheet ${texture.width}×${texture.height}, detected ${frameCount} frames in ${FRAMES_PER_ROW}×${animDef.rows} grid, frame ${fw}×${fh}`);
          result[animName] = extractFrames(texture, frameCount, fw, fh);
          anyLoaded = true;
        } catch {
          // sprite file not present — silently fall back to Graphics for this animation
        }
      }
      cache.set(type, anyLoaded ? result : null);
    }),
  );
}

/** Returns the loaded sprite set for a character type, or null if none is available. */
export function getSpriteSet(type: string): LoadedSpriteSet | null {
  return cache.get(type) ?? null;
}
