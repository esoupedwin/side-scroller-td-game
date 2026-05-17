import * as PIXI from 'pixi.js';

export type AnimationName = 'idle' | 'walk' | 'attack' | 'attackWalk' | 'carry';

export interface SpriteAnimDef {
  path:        string;  // URL served from /public, e.g. '/sprites/conscript/walk.png'
  cols:        number;  // frames per row in the spritesheet
  rows:        number;  // rows in the spritesheet
  fps:         number;  // desired playback speed in frames per second
  spriteScale: number;  // height = config.height * spriteScale (compensates for frame padding)
}

export type SpriteSetDef    = Partial<Record<AnimationName, SpriteAnimDef>>;
export type LoadedSpriteSet = Partial<Record<AnimationName, PIXI.Texture[]>>;

// ── Add entries here when sprite files are placed in /public/sprites/<type>/ ──
const SPRITE_DEFS: Partial<Record<string, SpriteSetDef>> = {
  conscript: {
    idle:   { path: '/sprites/conscript/idle.png',   cols: 6, rows: 2, fps:  8, spriteScale: 4.0 },
    walk:   { path: '/sprites/conscript/walk.png',   cols: 6, rows: 2, fps: 10, spriteScale: 4.0 },
    attack: { path: '/sprites/conscript/attack.png', cols: 6, rows: 2, fps: 12, spriteScale: 4.0 },
    carry:  { path: '/sprites/conscript/carry.png',  cols: 6, rows: 2, fps: 10, spriteScale: 4.0 },
  },
  warrior: {
    idle:   { path: '/sprites/warrior/idle.png',   cols: 6, rows: 2, fps:  8, spriteScale: 4.0 },
    walk:   { path: '/sprites/warrior/walk.png',   cols: 6, rows: 2, fps: 10, spriteScale: 4.0 },
    attack: { path: '/sprites/warrior/attack.png', cols: 6, rows: 2, fps: 12, spriteScale: 4.0 },
    carry:  { path: '/sprites/warrior/carry.png',  cols: 6, rows: 2, fps: 10, spriteScale: 4.0 },
  },
};

export function getAnimFps(type: string, anim: AnimationName): number {
  return SPRITE_DEFS[type]?.[anim]?.fps ?? 10;
}

export function getSpriteScale(type: string, anim: AnimationName): number {
  return SPRITE_DEFS[type]?.[anim]?.spriteScale ?? 1.0;
}

function extractFrames(texture: PIXI.Texture, cols: number, rows: number): PIXI.Texture[] {
  const fw = Math.floor(texture.width  / cols);
  const fh = Math.floor(texture.height / rows);
  const frames: PIXI.Texture[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      frames.push(new PIXI.Texture(
        texture.baseTexture,
        new PIXI.Rectangle(c * fw, r * fh, fw, fh),
      ));
    }
  }
  return frames;
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
          const texture = await PIXI.Assets.load<PIXI.Texture>(animDef.path);
          const fw = Math.floor(texture.width / animDef.cols);
          const fh = Math.floor(texture.height / animDef.rows);
          console.log(`[sprites] ${type}/${animName}: sheet ${texture.width}×${texture.height}, frame ${fw}×${fh}`);
          result[animName] = extractFrames(texture, animDef.cols, animDef.rows);
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
