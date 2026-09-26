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
 * One Howl per listed file. Every entry in GameConfig.audio.sounds is a real
 * file (variants of the same sound are separate entries), so nothing is probed
 * and nothing 404s.
 */
function loadVariant(id: AudioSpriteId, src: string): void {
  const h = new Howl({
    src:     [src],
    volume:  masterVolume,
    preload: true,
    onload: () => {
      const pool = instances.get(id) ?? [];
      pool.push(h);
      instances.set(id, pool);
    },
    onloaderror: (_sid, err) => {
      console.warn(`[audio] "${id}" failed to load ${src}:`, err);
    },
  });
}

/**
 * Load every sound. Idempotent. Deliberately NOT called at startup: the game
 * starts muted, so the ~8 MB of WAV download + decode waits for the first
 * unmute (see setMuted). On a phone that is the difference between the splash
 * appearing after the JS or after the audio — measured 190 requests / 13 MB
 * before first paint with the old eager probe-and-preload.
 * playSoundAt() silently skips sounds that haven't loaded yet.
 */
let audioLoadStarted = false;
export function initAudio(): void {
  if (audioLoadStarted) return;
  audioLoadStarted = true;
  for (const [id, srcs] of Object.entries(SFX_SOUNDS) as [AudioSpriteId, readonly string[]][]) {
    for (const src of srcs) loadVariant(id, src);
  }
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
  if (!next) initAudio();   // first unmute pays for the audio load, not startup
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
