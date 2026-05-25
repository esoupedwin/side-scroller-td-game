import { Howl } from 'howler';
import { SFX_VOLUME, SFX_SOUNDS, SFX_SPATIAL_MAX_DIST, SFX_SPATIAL_MIN_VOL } from './constants';

/** Union of every sound ID defined in gameConfig.ts → audio.sounds. */
export type AudioSpriteId = keyof typeof SFX_SOUNDS;

/**
 * Pool of loaded Howl instances per sound ID.
 * Multiple variants (sword_slash-01, sword_slash-02, …) share the same pool;
 * playSoundAt picks one at random each time.
 */
const instances = new Map<AudioSpriteId, Howl[]>();

// ── Mute ────────────────────────────────────────────────────────────────────
// Game starts muted by default. masterVolume is the *effective* volume passed
// to Howl instances, while preMuteVolume remembers the level to restore on
// unmute. Both are decoupled from the configured SFX_VOLUME baseline so
// changing volume at runtime (e.g. via a settings panel) plays nicely with
// the mute toggle.
let muted: boolean        = true;
let preMuteVolume: number = SFX_VOLUME;

/** Master volume — tracks the user-adjusted level so per-play volumes scale with it. */
let masterVolume: number = muted ? 0 : SFX_VOLUME;

/** Current viewport bounds in world-space px (updated each tick by Game.ts). */
let viewportLeft  = 0;
let viewportRight = Infinity;

/** Maximum numbered variants probed per sound ID (e.g. sword_slash-01 … sword_slash-09). */
const MAX_VARIANTS = 9;

/**
 * Call once per tick from Game.ts after the camera position is resolved.
 * Both values are in world-space pixels (before GAME_ZOOM).
 */
export function setViewport(left: number, right: number): void {
  viewportLeft  = left;
  viewportRight = right;
}

/**
 * Linear attenuation multiplier for a sound at `worldX`.
 * Returns 1.0 inside the viewport, falling to spatialMinVol at spatialMaxDist px beyond the edge.
 */
function spatialMult(worldX: number): number {
  const dist = Math.max(0, viewportLeft - worldX, worldX - viewportRight);
  if (dist <= 0) return 1;
  return Math.max(SFX_SPATIAL_MIN_VOL, 1 - dist / SFX_SPATIAL_MAX_DIST);
}

/**
 * Probe a URL with a HEAD request.
 * Returns the URL if it exists (HTTP 2xx), otherwise null.
 * Used to confirm a variant file exists before handing it to Howler,
 * so Howler never receives a path that 404s.
 */
async function probe(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return r.ok ? url : null;
  } catch {
    return null;
  }
}

/**
 * Given the base source list for a sound and a variant index (1-based),
 * probe each format extension in order and return the first URL that exists.
 * Returns null if no format variant file is found for that index.
 */
async function findVariantSrc(baseSrcs: readonly string[], n: number): Promise<string | null> {
  const suffix = n.toString().padStart(2, '0');
  for (const src of baseSrcs) {
    const dot    = src.lastIndexOf('.');
    const varSrc = `${src.slice(0, dot)}-${suffix}${src.slice(dot)}`;
    const found  = await probe(varSrc);
    if (found) return found;
  }
  return null;
}

/**
 * Create a Howl for a single confirmed source path and add it to the pool on load.
 * Because the src is already confirmed to exist, Howler will never 404.
 */
function loadVariant(id: AudioSpriteId, srcs: string[]): void {
  const h = new Howl({
    src:     srcs,
    volume:  masterVolume,
    preload: true,
    onload: () => {
      const pool = instances.get(id) ?? [];
      pool.push(h);
      instances.set(id, pool);
      console.log(`[audio] "${id}" variant loaded (${pool.length} in pool)`);
    },
    onloaderror: (_sid, err) => {
      console.warn(`[audio] "${id}" failed to load:`, err);
    },
  });
}

/**
 * Load the base file for a sound, then probe for numbered variants (-01, -02, …)
 * sequentially. Stops at the first missing slot (assumes sequential numbering).
 * All sounds run in parallel; variants within each sound are probed in order.
 */
async function loadSoundWithVariants(id: AudioSpriteId, srcs: readonly string[]): Promise<void> {
  // Base file — pass the full format list so Howler picks the best supported format.
  // The base file is expected to exist; if all formats 404 the warning fires once.
  loadVariant(id, srcs as string[]);

  // Numbered variants: discover via HEAD, then load a single confirmed path.
  for (let i = 1; i <= MAX_VARIANTS; i++) {
    const src = await findVariantSrc(srcs, i);
    if (!src) break;          // no file for this slot → no more variants
    loadVariant(id, [src]);   // single confirmed path, Howler won't 404
  }
}

/**
 * Kick off loading for all sounds and their numbered variants, then return immediately.
 * Audio loads in the background; playSoundAt() silently skips sounds not yet ready.
 * Call once from main.ts after preloadAllSprites().
 */
export function initAudio(): void {
  const entries = Object.entries(SFX_SOUNDS) as [AudioSpriteId, readonly string[]][];
  void Promise.all(
    entries
      .filter(([, srcs]) => srcs.length > 0)
      .map(([id, srcs]) => loadSoundWithVariants(id, srcs)),
  );
}

/**
 * Play a randomly-chosen variant of `id` at the given world-space position.
 * Volume is attenuated when the position is outside the current viewport.
 * No-op if no variant has loaded yet.
 */
export function playSoundAt(id: AudioSpriteId, worldX: number): void {
  const pool = instances.get(id);
  if (!pool || pool.length === 0) return;

  const idx  = Math.floor(Math.random() * pool.length);
  const h    = pool[idx];
  const mult = spatialMult(worldX);
  const sid  = h.play();
  h.volume(masterVolume * mult, sid);
}

/**
 * Play a randomly-chosen variant at full volume (no spatial attenuation).
 * Use for UI sounds or events without a meaningful world position.
 */
export function playSound(id: AudioSpriteId): void {
  const pool = instances.get(id);
  if (!pool || pool.length === 0) return;
  pool[Math.floor(Math.random() * pool.length)].play();
}

/** Adjust the master SFX volume for all loaded sounds at runtime (0–1). */
export function setSfxVolume(v: number): void {
  masterVolume = Math.max(0, Math.min(1, v));
  instances.forEach((pool) => pool.forEach((h) => h.volume(masterVolume)));
}

export function isMuted(): boolean { return muted; }

export function setMuted(next: boolean): void {
  if (next === muted) return;
  muted = next;
  if (muted) {
    preMuteVolume = masterVolume;
    setSfxVolume(0);
  } else {
    setSfxVolume(preMuteVolume);
  }
}

export function toggleMute(): boolean {
  setMuted(!muted);
  return muted;
}
